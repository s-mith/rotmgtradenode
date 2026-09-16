// The site-facing HTTP surface, shape-compatible with pyrelay_http so the
// website's existing pyrelay client keeps working. Mounted in-process by the
// site (see src/server) or served standalone by src/relay/main.ts.
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import type { Fleet } from "./fleet/fleet";

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const IGN_RE = /^[A-Za-z]{1,32}$/;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type PoolPayload = {
  /**
   * Per pool half, the most free slots any bot the routing would actually
   * send for a deposit has: not suspended, not somebody's vault bot, not held
   * by a chore, not parked as standby, resident or login desk, not in a login
   * lockout. What the site's deposit gate promises (lib/depositRequest.ts).
   */
  room?: { seasonal: { largestFree: number; canMake: boolean }; nonseasonal: { largestFree: number; canMake: boolean } };
  ok: true;
  bots: Record<string, Readonly<Record<string, number>>>;
  capacities: Record<string, number>;
  instances: Record<string, Readonly<Record<string, { instanceId: string; itemId: string; enchantments: number[]; capturedAt: number }>>>;
  botMeta: Record<string, { ign: string; server: string; online: boolean; seasonal: boolean }>;
};

/** The last payload per fleet and the state it described. */
const payloadMemo = new WeakMap<Fleet, { key: string; payload: PoolPayload }>();

/**
 * What the payload depends on besides the tracker's revision: the roster
 * (additions, suspensions, seasonality) and where the online bots are, which
 * no tracker event covers. Cheap: the online set is at most a few dozen.
 */
function poolPayloadKey(fleet: Fleet): string {
  const live: string[] = [];
  for (const acc of fleet.pool.all()) if (acc.online) live.push(acc.botGuid, acc.client!.server);
  return `${fleet.tracker.revision()}|${fleet.pool.revision}|${live.join(",")}`;
}

/**
 * The `/pool` payload: every bot's tracked inventory plus live metadata.
 *
 * Built once per distinct fleet state and shared by every caller until the
 * state moves, so the site's many readers (every deposit, withdraw, capacity
 * check, the served pool, the wishlist scan) get one object, and an identity
 * comparison tells them whether anything changed. The per-bot records are
 * the tracker's own: read-only for everyone downstream.
 */
export function poolPayload(fleet: Fleet): PoolPayload {
  const key = poolPayloadKey(fleet);
  const hit = payloadMemo.get(fleet);
  if (hit && hit.key === key) return hit.payload;
  const suspended = fleet.pool.suspendedBotGuids();
  const bots: PoolPayload["bots"] = {};
  for (const [g, inv] of fleet.tracker.itemsView()) if (!suspended.has(g)) bots[g] = inv;
  const capacities: PoolPayload["capacities"] = {};
  for (const [g, cap] of fleet.tracker.capacityView()) if (!suspended.has(g)) capacities[g] = cap;
  const instances: PoolPayload["instances"] = {};
  for (const [g, slots] of fleet.tracker.instancesView()) if (!suspended.has(g)) instances[g] = slots as unknown as PoolPayload["instances"][string];
  const igns = fleet.tracker.ignsView();
  const botMeta: PoolPayload["botMeta"] = {};
  for (const acc of fleet.pool.all()) {
    // Suspended accounts stay listed (the operator's views name them) but
    // are marked, so the site's room maths and vault-bot picks skip them.
    botMeta[acc.botGuid] = { ign: igns.get(acc.botGuid) ?? "", server: acc.online ? acc.client!.server : "", online: acc.online, seasonal: acc.seasonalOrDefault, ...(acc.suspended ? { suspended: true } : {}) };
  }
  const largest = fleet.dispatcher?.largestFreeByPool();
  // `canMake`: no 16-slot bot may be ready, but an empty account could be
  // fitted with a backpack for a deposit that asks (the order lane) — which
  // only runs while the live chore is switched on.
  const liveChore = process.env.BACKPACK_CHORE_LIVE === "1";
  const room = largest
    ? {
        seasonal: { largestFree: largest.seasonal, canMake: liveChore && fleet.backpacks.canMakeBackpackBot(true) },
        nonseasonal: { largestFree: largest.nonseasonal, canMake: liveChore && fleet.backpacks.canMakeBackpackBot(false) },
      }
    : undefined;
  const payload: PoolPayload = { ok: true, bots, capacities, instances, botMeta, ...(room ? { room } : {}) };
  payloadMemo.set(fleet, { key, payload });
  return payload;
}

export function createControlPlane(fleet: Fleet, auth: () => string | undefined = () => process.env.PYRELAY_AUTH): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("*", async (c, next) => {
    if (c.req.path.endsWith("/healthz")) return next();
    const expected = auth();
    if (!expected) return c.json({ error: "PYRELAY_AUTH not configured" }, 500);
    if (!safeEqual(c.req.header("x-pyrelay-auth") ?? "", expected)) return c.json({ error: "bad auth" }, 401);
    return next();
  });

  app.get("/pool", (c) => c.json(poolPayload(fleet)));

  app.get("/inventories", (c) => {
    const since = c.req.query("since") ?? "";
    const live = [];
    for (const acc of fleet.pool.all()) {
      // The dispatcher attaches its clients to the account; maintenance
      // routines (backpack chore, daily login, sweeps) only register in the
      // fleet's client map. Both belong on the console.
      const client = acc.online ? acc.client! : fleet.clients.get(acc.guid);
      if (!client || !client.active) continue;
      const session = fleet.dispatcher?.liveView().find((v) => v.acc === acc)?.session;
      live.push({
        guid: acc.botGuid, alias: acc.alias, server: client.server, seasonal: acc.seasonalOrDefault,
        assigned: acc.assignedKind, partner: acc.assignedPartnerIgn, inWorld: client.objectId !== -1, queuePos: client.queuePos,
        trade: session?.partnerView() ?? null,
        // Maintenance the backpack service is doing with this bot (chore trip step, daily login); null when it is the dispatcher's.
        activity: fleet.backpacks.activityOf(acc.guid),
      });
    }
    live.sort((a, b) => a.server.localeCompare(b.server) || a.alias.localeCompare(b.alias));
    const liveKey = live.map((b) => `${b.guid}:${b.server}:${b.assigned}:${b.partner}:${b.inWorld}:${b.queuePos}:${b.activity ?? ""}:${b.trade ? `${b.trade.ign}/${b.trade.phase}/${b.trade.items.map((i) => `${i.slot}.${i.realmId}.${Number(i.offered)}`).join(",")}` : ""}`).join("|");
    const rev = `${fleet.tracker.revision()}:${createHash("sha1").update(liveKey).digest("hex").slice(0, 12)}`;
    if (since && since === rev) return c.json({ ok: true, unchanged: true, rev });
    const tracked = fleet.tracker.onlineView(live.map((b) => b.guid));
    const bots = live.map((b) => {
      const t = tracked[b.guid];
      const held = Object.values(t.items).reduce((a, v) => a + (v > 0 ? v : 0), 0);
      return { ...b, items: t.items, capacity: t.capacity, ign: t.ign, verifiedAt: t.verifiedAt, held, free: Math.max(0, t.capacity - held) };
    });
    return c.json({ ok: true, rev, capturedAt: Date.now() / 1000, bots });
  });

  // How gathered the potion pool is, and what the planner is up to.
  app.get("/consolidation", (c) => {
    const d = fleet.dispatcher;
    return c.json({ ok: true, ...(d ? d.consolidationStatus() : { enabled: false, pools: [], pending: [], lastPlan: [] }) });
  });

  app.get("/settings", (c) => c.json({ ok: true, settings: fleet.settings.all() }));
  app.post("/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    if ("pool_has_backpack" in body) fleet.settings.setPoolHasBackpack(Boolean(body.pool_has_backpack));
    return c.json({ ok: true, settings: fleet.settings.all() });
  });

  // Exit IPs: what's loaded, who's on what, and the operator's on/off switch
  // per host. A disabled host isn't handed out again; a bot already on it
  // keeps its session until it disconnects on its own. Credentials ride
  // along so the console can hand an operator the lines for hosts they've
  // pulled out of rotation (to use elsewhere, or to report to Webshare).
  const proxiesPayload = () => {
    const hosts = fleet.proxies.healthReport().map((h) => {
      const acc = h.usedBy ? fleet.pool.byGuid(h.usedBy) : undefined;
      const p = fleet.proxies.entry(h.host);
      return { ...h, usedBy: acc?.alias ?? h.usedBy, username: p?.username ?? "", password: p?.password ?? "" };
    });
    return { ok: true, source: fleet.proxies.sourceStatus(), capacity: fleet.proxies.exclusiveCapacity(), inUse: fleet.proxies.occupiedCount(), proxies: hosts };
  };
  app.get("/proxies", (c) => c.json(proxiesPayload()));
  app.post("/proxies", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    if (body.host === undefined || body.host === null) {
      fleet.proxies.setAllEnabled(body.enabled);
    } else {
      const host = String(body.host).trim();
      if (!fleet.proxies.setEnabled(host, body.enabled)) return c.json({ error: `unknown proxy host ${host}` }, 404);
    }
    return c.json(proxiesPayload());
  });
  app.post("/proxies/refresh", async (c) => {
    const r = await fleet.proxies.refresh();
    return c.json({ ...proxiesPayload(), refresh: r });
  });

  app.post("/whisper", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const ign = String(body.ign ?? "").trim();
    const code = String(body.code ?? "").trim();
    if (!IGN_RE.test(ign)) return c.json({ error: "invalid ign" }, 400);
    if (!CODE_RE.test(code)) return c.json({ error: "invalid code" }, 400);
    const igns = fleet.tracker.ignsSnapshot();
    const chosen = fleet.pool.all().find((a) => a.online && igns[a.botGuid]);
    if (!chosen) return c.json({ error: "no bot online" }, 503);
    if (!fleet.whispers.queue(chosen.botGuid, `/tell ${ign} ${code}`)) return c.json({ error: "whisper queue full, retry shortly" }, 503);
    fleet.log(`[ign-verify] queued whisper to ${ign} via ${chosen.alias}`);
    return c.json({ ok: true, botGuid: chosen.botGuid, botIgn: igns[chosen.botGuid] ?? "" });
  });

  app.post("/login/register-code", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const code = String(body.code ?? "").trim();
    if (!CODE_RE.test(code)) return c.json({ error: "invalid code" }, 400);
    const chosen = fleet.dispatcher?.electLoginBot() ?? null;
    if (!chosen) return c.json({ error: "no login-desk bot ready" }, 503);
    fleet.loginCodes.register(code);
    fleet.log(`[login] registered code, tell target ${chosen.ign || chosen.acc.alias}`);
    return c.json({ ok: true, botGuid: chosen.acc.botGuid, botIgn: chosen.ign });
  });

  app.get("/login/code-state", (c) => {
    const code = (c.req.query("code") ?? "").trim();
    if (!CODE_RE.test(code)) return c.json({ error: "invalid code" }, 400);
    const st = fleet.loginCodes.state(code);
    return c.json({ ok: true, state: st.state, ign: st.ign });
  });

  // Backpacks: HTTP audit, in-game chore (docs/relay/BACKPACKS.md).
  app.get("/servers", (c) => c.json({ ok: true, ...fleet.serverUsage.status() }));
  app.get("/backpacks", (c) => c.json({ ok: true, ...fleet.backpacks.status(), seasonWatch: fleet.seasonWatch.status() }));
  app.get("/backpacks/accounts", (c) => {
    const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 200) || 200, 20000));
    const only = (c.req.query("only") ?? "").trim();
    let rows = fleet.backpacks.accounts();
    if (only === "claimable") rows = rows.filter((r) => r.backpackDays.some((d) => d.claimable));
    else if (only === "nobackpack") rows = rows.filter((r) => r.hasBackpack === false);
    else if (only === "banked") rows = rows.filter((r) => (r.banked ?? 0) > 0);
    else if (only === "errors") rows = rows.filter((r) => r.lastError !== null);
    else if (only === "needlogin") rows = rows.filter((r) => !r.loginDays.includes(new Date().toISOString().slice(0, 10)));
    return c.json({ ok: true, total: rows.length, accounts: rows.slice(0, limit) });
  });
  app.get("/backpacks/plan", (c) => c.json({ ok: true, plan: fleet.backpacks.plan(c.req.query("buffer") !== undefined ? Number(c.req.query("buffer")) : undefined) }));
  app.post("/backpacks/audit", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number; guids?: string[]; unauditedOnly?: boolean };
    try {
      return c.json({ ok: true, audit: fleet.backpacks.startAudit({ limit: Number(body.limit) || undefined, guids: Array.isArray(body.guids) ? body.guids.map(String) : undefined, unauditedOnly: body.unauditedOnly === true }) });
    } catch (e) {
      return c.json({ error: (e as Error).message, audit: fleet.backpacks.status().audit }, 409);
    }
  });
  app.post("/backpacks/audit/cancel", (c) => c.json({ ok: true, stopping: fleet.backpacks.cancelAudit() }));
  app.post("/backpacks/chore", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: string; limit?: number; guids?: string[]; equip?: boolean; plan?: boolean; buffer?: number };
    const mode = body.mode === "live" ? "live" : "dry";
    if (mode === "live" && process.env.BACKPACK_CHORE_LIVE !== "1") return c.json({ error: "live chore is disabled: set BACKPACK_CHORE_LIVE=1 on the fleet" }, 403);
    try {
      return c.json({ ok: true, chore: fleet.backpacks.startChore({ mode, limit: Number(body.limit) || undefined, guids: Array.isArray(body.guids) ? body.guids.map(String) : undefined, equip: body.equip === true, plan: body.plan === true, buffer: typeof body.buffer === "number" ? body.buffer : undefined }) });
    } catch (e) {
      return c.json({ error: (e as Error).message, chore: fleet.backpacks.status().chore }, 409);
    }
  });
  app.post("/backpacks/chore/cancel", (c) => c.json({ ok: true, stopping: fleet.backpacks.cancelChore() }));
  // Roster intake: an account that has already done its tutorial goes
  // straight in; the onboarding service handles the rest (src/accountgen).
  app.post("/accounts", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: string; password?: string; seasonal?: boolean; alias?: string; server?: string } | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "email looks wrong" }, 400);
    if (!password) return c.json({ error: "password is required" }, 400);
    const acc = fleet.pool.addPulled({ guid: email, password, alias: (body.alias ?? "").trim() || email.split("@")[0], seasonal: body.seasonal !== false, ...(body.server ? { server: String(body.server) } : {}) });
    if (!acc) return c.json({ error: "that account is already on the roster" }, 409);
    fleet.log(`roster: added ${acc.alias} (${acc.seasonalOrDefault ? "seasonal" : "non-seasonal"})`);
    return c.json({ ok: true, account: { alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, seasonal: acc.seasonal } });
  });

  // Node status and knobs (design doc §8): build gate, server list, telemetry.
  app.get("/node", (c) => c.json({ ok: true, build: fleet.buildGate.status(), servers: fleet.servers.status(), telemetry: fleet.telemetry.status(), version: fleet.versions.current, feed: { polling: fleet.versions.polling, lastFetchAt: fleet.versions.lastFetchAt, lastError: fleet.versions.lastError, info: fleet.versions.lastInfo } }));
  app.post("/node/build/canary", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { server?: string };
    const r = await fleet.buildGate.canary(body.server ? String(body.server) : undefined);
    return c.json({ ok: r.ok, canary: r, build: fleet.buildGate.status() }, r.ok ? 200 : 409);
  });
  app.post("/node/build/trust", (c) => {
    fleet.buildGate.trust();
    return c.json({ ok: true, build: fleet.buildGate.status() });
  });
  app.post("/node/telemetry", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean; hubUrl?: string } | null;
    if (!body || typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    fleet.telemetry.setEnabled(body.enabled, typeof body.hubUrl === "string" ? body.hubUrl : undefined);
    return c.json({ ok: true, telemetry: fleet.telemetry.status() });
  });
  app.post("/node/telemetry/flush", async (c) => c.json({ ok: true, sent: await fleet.telemetry.flush(), telemetry: fleet.telemetry.status() }));

  app.get("/account", (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 25) || 25, 100));
    const igns = fleet.tracker.ignsSnapshot();
    const caps = fleet.tracker.capacities();
    const hits = fleet.pool.every().filter((a) => !q || a.alias.toLowerCase().includes(q) || a.guid.toLowerCase().includes(q) || a.botGuid.toLowerCase().includes(q) || (igns[a.botGuid] ?? "").toLowerCase().includes(q));
    hits.sort((a, b) => Number(a.suspended) - Number(b.suspended) || a.alias.toLowerCase().localeCompare(b.alias.toLowerCase()));
    const accounts = hits.slice(0, limit).map((acc) => {
      const client = acc.client;
      const connected = !!client && client.active && client.isReady && client.connected;
      const items = Object.entries(fleet.tracker.instancesFor(acc.botGuid)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([slot, i]) => ({ slot: Number(slot), instanceId: i.instanceId, itemId: i.itemId, enchantments: i.enchantments, capturedAt: i.capturedAt }));
      const stamps = items.map((i) => i.capturedAt).filter(Boolean);
      return {
        alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, ign: igns[acc.botGuid] ?? "", server: connected ? client!.server : "",
        online: connected, inWorld: connected && client!.objectId !== -1, seasonal: acc.seasonal, suspended: acc.suspended,
        inUse: acc.inUse, assignedKind: acc.assignedKind, assignedRequestId: acc.assignedRequestId, capacity: caps[acc.botGuid] ?? 8,
        held: items.length, lastSeen: stamps.length ? Math.max(...stamps) : null, items,
      };
    });
    return c.json({ ok: true, total: hits.length, accounts });
  });

  return app;
}
