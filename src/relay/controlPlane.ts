// The site-facing HTTP surface, shape-compatible with pyrelay_http so the
// website's existing pyrelay client keeps working. Mounted in-process by the
// site (see src/server) or served standalone by src/relay/main.ts.
import { Hono } from "hono";
import * as itemPolicyLib from "../lib/itemPolicy";
import * as nodeSettingsLib from "../node/settings";
import { CATALOG } from "../lib/catalog";
import { timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import type { Fleet } from "./fleet/fleet";
import { onlineCapFor } from "./fleet/constants";
import { MAX_NODE_BOTS } from "../shared/hubWire";
import { LOCKOUT_WAIT_MS } from "./fleet/borrow";
import type { StoredInstance } from "./fleet/storage";
import { parseProxyText, type Proxy } from "./net/proxy";
import { loginStats } from "./fleet/tokenCache";
import { buildStatus, statusFacts } from "../node/status";
import { buildDiagnostics, type DiagnosticsSection } from "../node/diagnostics";

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
/** The hub's public version feed for a node that is not linked (the console's default hub). */
const DEFAULT_HUB_URL = "https://rotmg.trade";
const IGN_RE = /^[A-Za-z]{1,32}$/;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type PoolPayload = {
  /**
   * Per pool half, the most free slots any bot the routing would actually
   * send for a deposit has, counting a roomier character of the same side
   * the account would log in as for it: not suspended, not a communism
   * account, not held by a chore, not at the login desk, not in a login
   * lockout. What the site's deposit gate promises (lib/depositRequest.ts).
   */
  room?: { seasonal: { largestFree: number; canMake: boolean }; nonseasonal: { largestFree: number; canMake: boolean }; /** Only while advanced management is on for communism: the biggest communism deposit each side takes now. */ communism?: { seasonal: { largestFree: number }; nonseasonal: { largestFree: number } }; /** Advanced management: whether each side takes deposits into an empty character now, so a bigger one continues on the next (false: the old way). */ continues?: { seasonal: boolean; nonseasonal: boolean; communism: { seasonal: boolean; nonseasonal: boolean } } };
  ok: true;
  bots: Record<string, Readonly<Record<string, number>>>;
  capacities: Record<string, number>;
  instances: Record<string, Readonly<Record<string, { instanceId: string; itemId: string; enchantments: number[]; capturedAt: number }>>>;
  /**
   * Per bot, what its account keeps beyond the character's trade slots
   * (docs/relay/STORAGE.md): the vault chests, the potion rack, the gift and
   * spoils chests, and the other characters' trade slots. Each item says
   * where it is and which pool halves a character of the account could
   * carry it to; a withdraw naming one has the fleet fetch it first.
   */
  stored: Record<string, StoredInstance[]>;
  /**
   * Communism accounts: trade slots and what fills them over every living
   * character of the account's side, not just the played one. Deposits land
   * on the played character; when a deposit needs more room than it has, the
   * account logs in as a roomier character of its side (the dispatcher's
   * rotation, Dispatcher.rotateFor).
   */
  accountRoom?: Record<string, { slots: number; used: number }>;
  /**
   * Pool accounts with living characters on the other side of the seasonal
   * split from the one they play (botMeta.seasonal): that side's slots and
   * what fills them. The account serves that side too, by logging in as one
   * of those characters (Dispatcher.rotateAcross), so it is room there.
   */
  acrossRoom?: Record<string, { seasonal: boolean; slots: number; used: number }>;
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
  return `${fleet.tracker.revision()}|${fleet.pool.revision}|${fleet.storage.revision()}|${live.join(",")}`;
}

/**
 * The `/pool` payload: every bot's tracked inventory plus live metadata.
 *
 * Built once per distinct fleet state and shared by every caller until the
 * state moves, so the site's many readers (every deposit, withdraw, capacity
 * check, the served pool, the offer matcher) get one object, and an identity
 * comparison tells them whether anything changed. The per-bot records are
 * the tracker's own: read-only for everyone downstream.
 */
export function poolPayload(fleet: Fleet): PoolPayload {
  // The room figure reads dispatcher state the key does not cover (the login
  // desk, lockouts, assignments, holds, wakes), so it is computed every call:
  // a memo hit is reused only while its room still matches, else a fresh
  // object carries the new room (readers compare by identity).
  const key = poolPayloadKey(fleet);
  const room = poolRoom(fleet);
  const hit = payloadMemo.get(fleet);
  if (hit && hit.key === key) {
    if (sameRoom(hit.payload.room, room)) return hit.payload;
    const { room: _old, ...rest } = hit.payload;
    const payload: PoolPayload = { ...rest, ...(room ? { room } : {}) };
    payloadMemo.set(fleet, { key, payload });
    return payload;
  }
  const suspended = fleet.pool.suspendedBotGuids();
  const bots: PoolPayload["bots"] = {};
  // Only accounts on the roster: the tracker may still hold one that was removed (pruned at startup, but a removal mid-run is the same check).
  const onRoster = new Set(fleet.pool.every().map((a) => a.botGuid));
  const listed = (g: string) => onRoster.has(g) && !suspended.has(g);
  for (const [g, inv] of fleet.tracker.itemsView()) if (listed(g)) bots[g] = inv;
  const capacities: PoolPayload["capacities"] = {};
  for (const [g, cap] of fleet.tracker.capacityView()) if (listed(g)) capacities[g] = cap;
  const instances: PoolPayload["instances"] = {};
  for (const [g, slots] of fleet.tracker.instancesView()) if (listed(g)) instances[g] = slots as unknown as PoolPayload["instances"][string];
  const igns = fleet.tracker.ignsView();
  const stored: PoolPayload["stored"] = {};
  const botMeta: PoolPayload["botMeta"] = {};
  const accountRoom: NonNullable<PoolPayload["accountRoom"]> = {};
  const acrossRoom: NonNullable<PoolPayload["acrossRoom"]> = {};
  for (const acc of fleet.pool.all()) {
    if (!acc.communism && !acc.suspended) {
      const across = fleet.storage.charsFor(acc).filter((ch) => ch.seasonal !== acc.seasonalOrDefault);
      if (across.length) acrossRoom[acc.botGuid] = { seasonal: !acc.seasonalOrDefault, slots: across.reduce((n, ch) => n + ch.capacity, 0), used: across.reduce((n, ch) => n + ch.held, 0) };
    }
    if (!acc.suspended) {
      const s = fleet.storage.storedFor(acc);
      if (s.length) stored[acc.botGuid] = s;
    }
    if (acc.communism && !acc.suspended) {
      const side = fleet.storage.charsFor(acc).filter((ch) => ch.seasonal === acc.seasonalOrDefault);
      if (side.length) accountRoom[acc.botGuid] = { slots: side.reduce((n, ch) => n + ch.capacity, 0), used: side.reduce((n, ch) => n + ch.held, 0) };
    }
    // Suspended accounts stay listed (the operator's views name them) but
    // are marked, so the site's room maths and vault-bot picks skip them.
    botMeta[acc.botGuid] = { ign: igns.get(acc.botGuid) ?? "", server: acc.online ? acc.client!.server : "", online: acc.online, seasonal: acc.seasonalOrDefault, ...(acc.suspended ? { suspended: true } : {}), ...(acc.communism ? { communism: true } : {}) };
  }
  const payload: PoolPayload = { ok: true, bots, capacities, instances, stored, botMeta, ...(Object.keys(accountRoom).length ? { accountRoom } : {}), ...(Object.keys(acrossRoom).length ? { acrossRoom } : {}), ...(room ? { room } : {}) };
  payloadMemo.set(fleet, { key, payload });
  return payload;
}

function poolRoom(fleet: Fleet): PoolPayload["room"] {
  const largest = fleet.dispatcher?.largestFreeByPool();
  // `canMake` stays on the wire for older pages; nothing fits a bot with a backpack by itself any more
  // (the owner does it from the Accounts tab), so it is always false.
  return largest
    ? {
        seasonal: { largestFree: largest.seasonal, canMake: false },
        nonseasonal: { largestFree: largest.nonseasonal, canMake: false },
        ...(largest.communism ? { communism: { seasonal: { largestFree: largest.communism.seasonal }, nonseasonal: { largestFree: largest.communism.nonseasonal } } } : {}),
        ...(fleet.dispatcher ? { continues: fleet.dispatcher.intakeContinues() } : {}),
      }
    : undefined;
}

function sameRoom(a: PoolPayload["room"], b: PoolPayload["room"]): boolean {
  if (!a || !b) return a === b;
  const ac = a.communism, bc = b.communism;
  const sameCommunism = !ac || !bc ? ac === bc : ac.seasonal.largestFree === bc.seasonal.largestFree && ac.nonseasonal.largestFree === bc.nonseasonal.largestFree;
  const sameContinues = JSON.stringify(a.continues ?? null) === JSON.stringify(b.continues ?? null);
  return a.seasonal.largestFree === b.seasonal.largestFree && a.nonseasonal.largestFree === b.nonseasonal.largestFree && sameCommunism && sameContinues;
}

const CATALOG_SIZE = CATALOG.length;

export function createControlPlane(fleet: Fleet, auth: () => string | undefined = () => process.env.PYRELAY_AUTH): Hono {
  const app = new Hono();
  /** Trades with players as the console shows them: the owner's settings, how many bots can be online, and the meetings that allows at once. */
  const playersView = () => {
    const p = fleet.nodeSettings.get().players;
    const onlineCap = onlineCapFor(fleet.proxies.exclusiveCapacity());
    return { ...p, onlineCap, atOnce: nodeSettingsLib.playerMeetingsAtOnce(p, onlineCap) };
  };
  /**
   * The exit an account check with Realm goes out through. With a proxy list
   * it is never this computer's own address: while every host carries a bot,
   * the check waits for one to come free as long as a storage read would.
   */
  /**
   * Whether the login gate lets a check of `guid` go to Realm now: not while
   * logins are paused after Realm's attempt limit, nor while the account waits
   * out a cooldown of its own. A refusal is the reason, for the console.
   */
  const gateRefusal = (guid: string): string | null => {
    const paused = fleet.gate.ratePauseRemainingMs();
    if (paused > 0) return `logins are paused for another ${Math.ceil(paused / 1000)} s after Realm's login attempt limit; try again then`;
    const cooling = fleet.gate.cooldownRemainingMs(guid);
    if (cooling > 0) return `that account may not log in for another ${Math.ceil(cooling / 1000)} s (Realm's attempt limit, or it was in use); try again then`;
    return null;
  };
  /** Realm's attempt limit met by a check counts at the gate as one met by a login. */
  const noteProbe = (guid: string, r: { verdict: string; lockoutSeconds?: number }): void => {
    if (r.verdict === "attempt-limit" && r.lockoutSeconds) fleet.gate.noteAttemptLimit(guid, r.lockoutSeconds);
  };
  const checkProxy = async (guid: string): Promise<{ ok: true; proxy: Proxy | null } | { ok: false; error: string }> => {
    const refused = gateRefusal(guid);
    if (refused) return { ok: false, error: refused };
    if (!fleet.proxies.configured) return { ok: true, proxy: null };
    const proxy = await fleet.proxies.probeWhenFree(guid, Date.now() + LOCKOUT_WAIT_MS);
    return proxy ? { ok: true, proxy } : { ok: false, error: `no free proxy to ask Realm through (${fleet.proxies.noFreeHostReason()}); try again when one is free` };
  };

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
        activity: fleet.backpacks.activityOf(acc.guid) ?? fleet.storage.activityOf(acc.guid),
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
    const s = fleet.nodeSettings.get().proxies;
    return { ok: true, capacity: fleet.proxies.exclusiveCapacity(), inUse: fleet.proxies.occupiedCount(), proxies: hosts, required: s.required, ownInternetAt: s.ownInternetAt, text: fleet.proxies.listText() };
  };
  // The owner's pasted list (design doc §2: logins go through a proxy only).
  app.post("/proxies/list", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string") return c.json({ error: "text must be a string" }, 400);
    if (body.text.length > 200_000) return c.json({ error: "list too long" }, 400);
    const r = fleet.proxies.setList(body.text);
    if (r.error && !r.count) return c.json({ error: r.error, lines: r.lines }, 400);
    fleet.log(`proxies: owner saved a list of ${r.count} exit IP(s)${r.error ? ` (${r.error})` : ""}`);
    // What each pasted line was read as, so the console can point at the ones it skipped.
    return c.json({ ...proxiesPayload(), saved: { count: r.count, error: r.error }, lines: r.lines });
  });
  // A pasted list read without saving it: per line, the address it names or why it can't be used.
  app.post("/proxies/parse", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string") return c.json({ error: "text must be a string" }, 400);
    if (body.text.length > 200_000) return c.json({ error: "That list is too long." }, 400);
    const r = parseProxyText(body.text);
    return c.json({ ok: true, count: r.proxies.length, lines: r.lines });
  });
  // Check listed proxies (all, or the hosts named): the login, then Realm's website and a game server through each.
  app.post("/proxies/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { hosts?: unknown } | null;
    const hosts = Array.isArray(body?.hosts) ? body!.hosts.filter((h): h is string => typeof h === "string").slice(0, 1000) : [];
    if (!fleet.proxies.configured) return c.json({ error: "There are no proxies to test yet. Paste your list and save it first." }, 409);
    if (hosts.length && !fleet.proxies.entriesFor(hosts).length) return c.json({ error: "None of those proxies is on the list." }, 404);
    const results = await fleet.setup.testProxies(hosts);
    fleet.log(`proxies: tested ${results.length}, ${results.filter((r) => r.ok).length} working`);
    return c.json({ ok: true, results });
  });
  // Logins from this computer's own internet when no proxy is listed (one bot at a time): the owner says so, confirming the risk.
  app.post("/proxies/own-internet", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { allow?: unknown; acknowledged?: unknown } | null;
    if (!body || typeof body.allow !== "boolean") return c.json({ error: "allow must be true or false" }, 400);
    if (body.allow && body.acknowledged !== true) return c.json({ error: "Please confirm you understand the risk" }, 400);
    const allow = body.allow;
    fleet.nodeSettings.update((s) => {
      s.proxies.required = !allow;
      s.proxies.ownInternetAt = allow ? Date.now() : null;
    });
    fleet.log(allow ? "proxies: the owner allowed logins from this computer's own internet when no proxy is listed (one bot at a time), confirming the risk" : "proxies: logins go through a proxy only");
    return c.json(proxiesPayload());
  });
  app.post("/proxies/required", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.required !== "boolean") return c.json({ error: "required must be a boolean" }, 400);
    fleet.nodeSettings.update((s) => {
      s.proxies.required = body.required;
      if (body.required) s.proxies.ownInternetAt = null;
    });
    fleet.log(`proxies: logins ${body.required ? "go through a proxy only" : "may go direct when no proxy is listed"}`);
    return c.json(proxiesPayload());
  });
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
    if (!chosen) {
      // Nobody at the desk (it is staffed on demand): one logs in now; the site asks again with the same code until it is in the game.
      fleet.dispatcher?.requestLoginDesk();
      return c.json({ error: "no login-desk bot ready: one is logging in" }, 503);
    }
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
  // The chore in two halves, per account, from the Accounts tab: claim the reached backpack day(s) as the
  // played character; use a backpack from a chest on one character. Each returns at once and runs once the
  // account is free (the trip takes a minute); the account view's `backpacks.job` / `backpacks.lastJob` say
  // how it goes.
  app.post("/backpacks/claim", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string; seasonal?: unknown };
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    // The reward lands in the gift chest of the claiming character's side: the played character when it is
    // of the wanted side, else the lowest-numbered living character of that side.
    let charId: number | undefined;
    if (typeof body.seasonal === "boolean") {
      const chars = fleet.storage.charsFor(acc).filter((ch) => ch.seasonal === body.seasonal);
      const pick = chars.find((ch) => ch.login) ?? chars.sort((a, b) => a.id - b.id)[0];
      if (!pick) return c.json({ error: `no ${body.seasonal ? "seasonal" : "non-seasonal"} character on this account to claim with` }, 409);
      charId = pick.id;
    }
    const r = fleet.backpacks.startClaim(acc, charId);
    return r.ok ? c.json({ ok: true, started: true, charId: charId ?? null }) : c.json({ error: r.error }, 409);
  });
  app.post("/backpacks/consume", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string; charId?: unknown };
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    const charId = Number(body.charId);
    if (!Number.isInteger(charId) || charId < 0) return c.json({ error: "charId must be a character id" }, 400);
    const r = fleet.backpacks.startConsume(acc, charId);
    return r.ok ? c.json({ ok: true, started: true }) : c.json({ error: r.error }, 409);
  });
  app.post("/backpacks/daily-login", async (c) => c.json({ ok: true, pass: await fleet.backpacks.dailyLoginPass() }));
  // Take back the account's backpack job while it waits for the account.
  app.post("/backpacks/cancel", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string };
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    const r = fleet.backpacks.cancelWaiting(acc);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 409);
  });
  // What Realm says about an account the owner is about to add: credentials,
  // suspension, characters, tutorial state, the loaded character's season.
  app.post("/accounts/probe", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: string; password?: string } | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    // Kept as typed: Realm compares the address exactly as it was registered.
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "email looks wrong" }, 400);
    if (!password) return c.json({ error: "password is required" }, 400);
    if (fleet.nodeSettings.get().proxies.required && !fleet.proxies.configured) return c.json({ error: "no proxies listed and logins are set to go through a proxy only — paste some in the Proxies tab first" }, 409);
    const { probeAccount } = await import("./fleet/accountProbe");
    const via = await checkProxy(email);
    if (!via.ok) return c.json({ error: via.error }, 503);
    const r = await probeAccount({ guid: email, password }, via.proxy);
    fleet.proxies.releaseProbe(email);
    noteProbe(email, r);
    return c.json({ ok: true, probe: { verdict: r.verdict, detail: r.detail, tutorialDone: r.tutorialDone, chars: r.chars, loaded: r.loaded } });
  });
  // Roster intake. Realm is asked first: bad credentials and suspended
  // accounts are refused, the tutorial state and the loaded character's
  // season come from char/list, and an account with no character yet, or
  // its tutorial not done, is refused until its owner has played it.
  app.post("/accounts", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: string; password?: string; seasonal?: boolean; alias?: string; server?: string; } | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "email looks wrong" }, 400);
    if (!password) return c.json({ error: "password is required" }, 400);
    if (fleet.pool.byGuid(email)) return c.json({ error: "that account is already on the roster" }, 409);
    // The hub keeps track of so many accounts per node; past that it no longer sees this node's accounts properly.
    if (fleet.pool.every().length >= MAX_NODE_BOTS) return c.json({ error: `the roster already has ${fleet.pool.every().length} accounts, the most the hub keeps track of for one node (${MAX_NODE_BOTS}); remove one first` }, 409);
    let seasonal = body.seasonal !== false;
    let detected: { tutorialDone: boolean; chars: number; loaded: { id: number; seasonal: boolean; backpackSlots: number } | null } | null = null;
    // Realm is always asked: an account it was never checked against could be
    // suspended, mistyped or still in the tutorial (the old `probe: false`
    // skip is gone).
    if (fleet.nodeSettings.get().proxies.required && !fleet.proxies.configured) return c.json({ error: "no proxies listed and logins are set to go through a proxy only — paste some in the Proxies tab first" }, 409);
    const { probeAccount } = await import("./fleet/accountProbe");
    const via = await checkProxy(email);
    if (!via.ok) return c.json({ error: via.error }, 503);
    const r = await probeAccount({ guid: email, password }, via.proxy);
    fleet.proxies.releaseProbe(email);
    noteProbe(email, r);
    if (r.verdict === "bad-credentials") return c.json({ error: "Realm does not accept that email and password. Accounts that sign in through Steam, Google or Kongregate have no password for the game's API." }, 400);
    if (r.verdict === "suspended") return c.json({ error: "Realm says that account is suspended" }, 409);
    if (r.verdict === "attempt-limit") return c.json({ error: `Realm's login attempt limit: ${r.detail}` }, 429);
    if (r.verdict === "error") return c.json({ error: `could not reach Realm to check the account (${r.detail})` }, 502);
    detected = { tutorialDone: r.tutorialDone, chars: r.chars.length, loaded: r.loaded ? { id: r.loaded.id, seasonal: r.loaded.seasonal, backpackSlots: r.loaded.backpackSlots } : null };
    if (r.loaded) seasonal = r.loaded.seasonal;
    if (!r.loaded || !r.tutorialDone) return c.json({ error: "that account has no character past the tutorial yet; play it through in the game first, then add it" }, 409);
    const acc = fleet.pool.addPulled({ guid: email, password, alias: (body.alias ?? "").trim() || email.split("@")[0], seasonal, ...(body.server ? { server: String(body.server) } : {}) });
    if (!acc) return c.json({ error: "that account is already on the roster" }, 409);
    fleet.log(`roster: added ${acc.alias} (${acc.seasonalOrDefault ? "seasonal" : "non-seasonal"}${detected ? `, ${detected.chars} character(s), tutorial done` : ""}); sweeping it now`);
    return c.json({ ok: true, where: "roster", account: { alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, seasonal: acc.seasonal }, detected });
  });
  // Corrected credentials: Realm is asked with the pair first, and only an
  // accepted pair is saved. The email is the account's identity, so changing
  // it replaces the record and is refused while the old one holds items.
  // Take an account off the roster: the node forgets its login and everything it tracked on it.
  app.post("/accounts/remove", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { guid?: string } | null;
    if (!body || typeof body !== "object" || !body.guid) return c.json({ error: "guid required" }, 400);
    const acc = fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid);
    if (!acc) return c.json({ error: "no such account" }, 404);
    const r = fleet.dispatcher?.retireAccount(acc) ?? { ok: true as const };
    if (!r.ok) return c.json({ error: `${acc.alias} can't be removed right now: ${r.error}` }, 409);
    fleet.pool.remove(acc);
    fleet.tracker.removeBot(acc.botGuid);
    return c.json({ ok: true, guid: acc.guid, botGuid: acc.botGuid, alias: acc.alias });
  });

  app.post("/accounts/credentials", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { guid?: string; email?: string; password?: string } | null;
    if (!body || typeof body !== "object" || !body.guid) return c.json({ error: "guid required" }, 400);
    const acc = fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid);
    if (!acc) return c.json({ error: "no such account" }, 404);
    // Online for the dispatcher, or driven by a maintenance routine (a storage
    // trip, the backpack chore, a sweep) that only registers in fleet.clients.
    const maint = fleet.clients.get(acc.guid);
    if ((acc.client && acc.client.active) || (maint && maint.active) || fleet.dispatcher?.maintenanceHolds.has(acc.guid) || acc.assignedRequestId !== null || acc.inUse) return c.json({ error: "the account is online; try when it is idle" }, 409);
    if (fleet.nodeSettings.get().proxies.required && !fleet.proxies.configured) return c.json({ error: "no proxies listed and logins are set to go through a proxy only" }, 409);
    const email = String(body.email ?? "").trim() || acc.guid;
    const password = String(body.password ?? "") || acc.info.password || "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "that email does not look right" }, 400);
    if (!password) return c.json({ error: "this account has no password stored; give one" }, 400);
    // A different mailbox is a different account here; a corrected spelling of
    // the same one keeps its bot id, and with it everything filed under it.
    const { deriveBotGuid } = await import("./fleet/botPool");
    const movesIdentity = deriveBotGuid(email) !== acc.botGuid;
    // Everything the account holds, not only the played character: its vault,
    // chests and other characters are pool items too.
    const held = fleet.tracker.heldCount(acc.botGuid) + fleet.storage.storedFor(acc).length;
    if (movesIdentity && held > 0) return c.json({ error: `that account holds ${held} item(s) under its current email; take them off it before pointing it at a different mailbox` }, 409);
    const { probeAccount } = await import("./fleet/accountProbe");
    const via = await checkProxy(email);
    if (!via.ok) return c.json({ error: via.error }, 503);
    const r = await probeAccount({ guid: email, password }, via.proxy, acc.info.charId ?? null);
    fleet.proxies.releaseProbe(email);
    noteProbe(email, r);
    if (r.verdict === "bad-credentials") return c.json({ error: "Realm does not accept that email and password together" }, 400);
    if (r.verdict === "attempt-limit") return c.json({ error: `Realm's login attempt limit: ${r.detail}` }, 429);
    if (r.verdict === "error") return c.json({ error: `could not reach Realm to check them (${r.detail})` }, 502);
    let target = acc;
    if (email !== acc.guid) {
      const moved = fleet.pool.setEmail(acc, email);
      if ("error" in moved) return c.json({ error: moved.error }, 409);
      if (movesIdentity) fleet.tracker.removeBot(acc.botGuid);
      target = moved;
    }
    if (password !== target.info.password) fleet.pool.setPassword(target, password);
    fleet.gate.unlock(target.guid);
    const changed = [email !== acc.guid ? "email" : null, password !== acc.info.password ? "password" : null].filter(Boolean).join(" and ") || "nothing";
    fleet.log(`roster: ${target.alias} ${changed} corrected; Realm accepts the pair`);
    if (r.verdict === "suspended") return c.json({ ok: true, saved: true, botGuid: target.botGuid, note: "the credentials work, but Realm says the account is suspended" });
    void fleet.readAccount(target, "credentials corrected").catch((e) => fleet.log(`read after a credentials change failed: ${String(e)}`));
    return c.json({ ok: true, saved: true, botGuid: target.botGuid, detected: { tutorialDone: r.tutorialDone, chars: r.chars.length, loaded: r.loaded ? { id: r.loaded.id, seasonal: r.loaded.seasonal } : null } });
  });
  // Log an account in, read its inventory, log it out: the first look at a new account, or a fresh one on demand.
  app.post("/accounts/sweep", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guids?: unknown };
    const guids = Array.isArray(body.guids) ? body.guids.map(String) : [];
    const targets = fleet.pool.every().filter((a) => !a.suspended && (guids.includes(a.guid) || guids.includes(a.botGuid)));
    if (!targets.length) return c.json({ error: "no such account" }, 404);
    const results = [];
    for (const acc of targets) results.push({ alias: acc.alias, botGuid: acc.botGuid, verdict: await fleet.readAccount(acc, "read requested") });
    return c.json({ ok: true, results });
  });

  // Account storage (docs/relay/STORAGE.md): what each account's vault holds, the moves queued for it, the runs.
  app.get("/storage", (c) => c.json({ ok: true, ...fleet.storage.status() }));
  app.get("/storage/accounts/:botGuid", (c) => {
    const d = fleet.storage.account(c.req.param("botGuid"));
    return d ? c.json({ ok: true, account: d }) : c.json({ error: "no such account" }, 404);
  });
  // New characters on the account (Wizards of the chosen side), queued: `count` of them (1 by default), one login each, Realm's
  // cooldown apart; `cancel` takes back the ones still waiting (the one waiting for a busy account too). The fill pass makes
  // them by itself, the same cooldown apart.
  app.post("/storage/create-character", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string; seasonal?: unknown; fill?: unknown; count?: unknown; cancel?: unknown };
    if (body.fill === true) return c.json({ ok: true, pass: await fleet.storage.fillPass() });
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    if (body.cancel === true) return c.json(fleet.storage.unqueueCreates(acc));
    const r = fleet.storage.queueCreate(acc, body.seasonal === true, body.count === undefined ? 1 : Number(body.count));
    return r.ok ? c.json(r) : c.json({ error: r.error }, 409);
  });
  // Delete one of the account's characters (char/delete over HTTP): everything on it goes with it; the console confirms first.
  app.post("/storage/delete-character", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string; charId?: unknown };
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    const charId = Number(body.charId);
    if (!Number.isInteger(charId) || charId < 0) return c.json({ error: "charId must be a character id" }, 400);
    // Queued: the reply comes at once, the account view's `characterJobs` says how it goes. Several may wait; they go in one visit.
    const r = fleet.storage.queueDelete(acc, charId);
    return r.ok ? c.json({ ok: true, queued: true, queue: r.queue }) : c.json({ error: r.error }, 409);
  });
  // Take a queued delete back before it runs (the one under way cannot be).
  app.post("/storage/unqueue-delete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string; charId?: unknown };
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    const charId = Number(body.charId);
    if (!Number.isInteger(charId) || charId < 0) return c.json({ error: "charId must be a character id" }, 400);
    const r = fleet.storage.unqueueDelete(acc, charId);
    return r.ok ? c.json({ ok: true, queue: r.queue }) : c.json({ error: r.error }, 409);
  });
  // Drop items (thrown away in game), queued: the console names instances; the account view's `characterJobs` says how it goes.
  // `cancel` takes back the drops still queued.
  app.post("/storage/drop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string; instanceIds?: unknown; cancel?: unknown };
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    if (body.cancel === true) return c.json(fleet.storage.unqueueDrops(acc));
    const ids = Array.isArray(body.instanceIds) ? body.instanceIds.map(String).filter(Boolean) : [];
    const r = fleet.storage.queueDrop(acc, ids);
    return r.ok ? c.json({ ok: true, queued: r.queued }) : c.json({ error: r.error }, 409);
  });
  // Tuck the played character's items into its equipment slots and quickslots now (the pass does it when it is nearly full).
  app.post("/storage/tuck", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guid?: string; plan?: unknown };
    const acc = body.guid ? fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid) : undefined;
    if (!acc) return c.json({ error: "no such account" }, 404);
    if (body.plan === true) return c.json({ ok: true, moves: fleet.storage.tuckPlanFor(acc) });
    const r = await fleet.storage.tuck(acc);
    return c.json(r, r.ok ? 200 : 409);
  });
  app.post("/storage/moves", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { botGuid?: string; add?: unknown; remove?: unknown; clear?: boolean } | null;
    if (!body || typeof body !== "object" || !body.botGuid) return c.json({ error: "botGuid required" }, 400);
    if (body.clear) fleet.storage.unqueue(body.botGuid);
    else if (Array.isArray(body.remove)) fleet.storage.unqueue(body.botGuid, body.remove.map(String));
    if (Array.isArray(body.add)) {
      const r = fleet.storage.queue(body.botGuid, body.add as { kind: never; instanceId?: string; slot?: number }[]);
      if (!r.ok) return c.json({ error: r.error, account: fleet.storage.account(body.botGuid) }, 409);
    }
    return c.json({ ok: true, account: fleet.storage.account(body.botGuid) });
  });
  app.post("/storage/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guids?: unknown; refresh?: boolean };
    try {
      return c.json({ ok: true, run: fleet.storage.startRun({ guids: Array.isArray(body.guids) ? body.guids.map(String) : undefined, refresh: !!body.refresh }) });
    } catch (e) {
      return c.json({ error: (e as Error).message, run: fleet.storage.status().run }, 409);
    }
  });
  app.post("/storage/run/cancel", (c) => c.json({ ok: true, stopping: fleet.storage.cancelRun() }));
  // Which character an account logs in with from now on (null: the first one). Takes effect at its next login.
  app.post("/accounts/char", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { guid?: string; charId?: unknown } | null;
    if (!body || typeof body !== "object" || !body.guid) return c.json({ error: "guid required" }, 400);
    const acc = fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid);
    if (!acc) return c.json({ error: "no such account" }, 404);
    const charId = body.charId === null || body.charId === undefined || body.charId === "" ? null : Number(body.charId);
    if (charId !== null && !Number.isInteger(charId)) return c.json({ error: "charId must be a number" }, 400);
    fleet.pool.setPreferredChar(acc, charId);
    return c.json({ ok: true, guid: acc.guid, botGuid: acc.botGuid, charId });
  });

  // Set an account aside for communism, or take it back. Items on it follow.
  app.post("/accounts/communism", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { guid?: string; communism?: unknown } | null;
    if (!body || typeof body !== "object" || !body.guid) return c.json({ error: "guid required" }, 400);
    const acc = fleet.pool.every().find((a) => a.guid === body.guid || a.botGuid === body.guid);
    if (!acc) return c.json({ error: "no such account" }, 404);
    fleet.pool.setCommunism(acc, body.communism === true);
    return c.json({ ok: true, guid: acc.guid, botGuid: acc.botGuid, communism: acc.communism });
  });

  // Re-check suspended accounts against Realm (HTTP only) and un-retire the ones it accepts.
  app.post("/accounts/retry-suspended", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { guids?: unknown };
    const guids = Array.isArray(body.guids) ? body.guids.map(String) : undefined;
    const { retrySuspended } = await import("./fleet/retrySuspended");
    const results = await retrySuspended({ pool: fleet.pool, gate: fleet.gate, proxies: fleet.proxies, requireProxy: () => fleet.nodeSettings.get().proxies.required, log: fleet.log }, guids);
    return c.json({ ok: true, results, cleared: results.filter((r) => r.verdict === "cleared").length });
  });

  // Node status and knobs (design doc §8): build gate, server list, telemetry.
  app.get("/node", (c) => c.json({ ok: true, build: fleet.buildGate.status(), servers: fleet.servers.status(), telemetry: fleet.telemetry.status(), hub: fleet.hub.status(), players: playersView(), loginDesk: fleet.dispatcher?.loginDeskStatus() ?? { alwaysOn: fleet.nodeSettings.get().loginDesk.alwaysOn, wanted: false, until: null, bot: null }, advanced: fleet.nodeSettings.get().advanced, advancedStatus: { ...(fleet.dispatcher?.advancedStatus() ?? {}), logins: loginStats() }, realmLogins: fleet.realmLogins.status(), version: fleet.versions.current, feed: { polling: fleet.versions.polling, lastFetchAt: fleet.versions.lastFetchAt, lastError: fleet.versions.lastError, info: fleet.versions.lastInfo } }));
  // Connected mode (design doc §4.3, docs/hub-protocol.md).
  app.post("/node/hub/link", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: string; code?: string; name?: string } | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const r = await fleet.hub.linkTo(String(body.url ?? ""), String(body.code ?? ""), String(body.name ?? "").trim() || "my node");
    if (!r.ok) return c.json({ error: r.error, hub: fleet.hub.status() }, r.status >= 400 ? (r.status as 400) : 502);
    return c.json({ ok: true, link: r.data, hub: fleet.hub.status() });
  });
  app.post("/node/hub/unlink", async (c) => {
    await fleet.hub.unlink();
    return c.json({ ok: true, hub: fleet.hub.status() });
  });
  app.post("/node/hub/heartbeat", async (c) => c.json({ ok: await fleet.hub.sendHeartbeat(), hub: fleet.hub.status() }));
  app.post("/node/build/canary", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { server?: string };
    const r = await fleet.buildGate.canary(body.server ? String(body.server) : undefined);
    return c.json({ ok: r.ok, canary: r, build: fleet.buildGate.status() }, r.ok ? 200 : 409);
  });
  app.post("/node/build/trust", (c) => {
    fleet.buildGate.trust();
    return c.json({ ok: true, build: fleet.buildGate.status() });
  });
  // "Check again" on a node paused for a Realm update: the game's version feed, then the hub's list of builds it confirmed.
  app.post("/node/build/check", async (c) => {
    const before = fleet.buildGate.status();
    await fleet.versions.refresh().catch(() => false);
    const s = fleet.nodeSettings.get();
    await fleet.hub.refreshVersion(fleet.hub.link?.url ?? (s.telemetry.hubUrl || DEFAULT_HUB_URL)).catch(() => null);
    const build = fleet.buildGate.status();
    const message = !build.held
      ? before.held ? "The new game version is confirmed. Bots carry on." : "Nothing is paused: bots can log in."
      : "Not confirmed yet. The node keeps waiting; check again later.";
    fleet.log(`build gate: owner checked again: ${build.build} ${build.held ? "still held" : "free"}`);
    return c.json({ ok: true, build, message });
  });
  // The computer woke up from sleep (the desktop app says so): log the bots out cleanly and let the proxies back.
  app.post("/node/resume", (c) => c.json({ ok: true, ...fleet.resume() }));
  // The first-run setup (scratchpad contract "Windows-ready node").
  app.get("/setup", (c) => c.json(fleet.setup.view()));
  app.post("/setup", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { action?: unknown; guid?: unknown } | null;
    switch (body?.action) {
      case "complete": return c.json(fleet.setup.complete());
      case "skip-hub": return c.json(fleet.setup.skipHub());
      case "reset": return c.json(fleet.setup.reset());
      case "test-login": {
        const r = fleet.setup.startTest(typeof body.guid === "string" && body.guid ? body.guid : undefined);
        return r.ok ? c.json({ ok: true, started: true }) : c.json({ error: r.error }, r.status);
      }
      default: return c.json({ error: "action must be complete, skip-hub, reset or test-login" }, 400);
    }
  });
  // The fleet's half of the status card; the site adds its own facts and words it (src/node/status.ts).
  app.get("/status", (c) => {
    const facts = statusFacts(fleet);
    return c.json({ ok: true, facts, status: buildStatus(facts) });
  });
  // The text an owner copies for whoever helps them, private parts taken out (src/node/diagnostics.ts).
  // POST adds what only the site knows: its facts for the status, and sections of its own.
  app.get("/diagnostics", (c) => c.json({ ok: true, text: buildDiagnostics(fleet) }));
  app.post("/diagnostics", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { site?: { communismError?: unknown; frozen?: unknown }; extra?: unknown } | null;
    const site = body?.site && typeof body.site === "object" ? { communismError: typeof body.site.communismError === "string" ? body.site.communismError : null, frozen: body.site.frozen === true } : undefined;
    const extra: DiagnosticsSection[] = Array.isArray(body?.extra)
      ? (body!.extra as unknown[]).filter((e): e is DiagnosticsSection => !!e && typeof e === "object" && typeof (e as DiagnosticsSection).title === "string" && Array.isArray((e as DiagnosticsSection).lines))
        .map((e) => ({ title: e.title.slice(0, 80), lines: e.lines.slice(0, 200).map((l) => String(l).slice(0, 500)) }))
      : [];
    return c.json({ ok: true, text: buildDiagnostics(fleet, { site, extra }) });
  });
  // Which catalog items this node takes in (src/lib/itemPolicy.ts).
  app.get("/node/log", (c) => c.json({ ok: true, lines: fleet.logTail(Number(c.req.query("n")) || undefined) }));
  app.get("/node/items", (c) => {
    const { acceptedIds, acceptsEverything } = itemPolicyLib;
    const policy = fleet.nodeSettings.get().items;
    return c.json({ ok: true, policy, accepted: acceptedIds(policy).size, total: CATALOG_SIZE, everything: acceptsEverything(policy) });
  });
  app.post("/node/items", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { policy?: unknown } | null;
    if (!body || typeof body !== "object" || !body.policy) return c.json({ error: "policy required" }, 400);
    const policy = itemPolicyLib.normalizeItemPolicy(body.policy);
    fleet.nodeSettings.update((s) => { s.items = policy; });
    const n = itemPolicyLib.acceptedIds(policy).size;
    fleet.log(`items: the node now takes ${n} of ${CATALOG_SIZE} catalog items`);
    return c.json({ ok: true, policy, accepted: n, total: CATALOG_SIZE, everything: itemPolicyLib.acceptsEverything(policy) });
  });
  // Trades with players (docs/hub-protocol.md, "Player meetings"): hub users without a node may take this node's offers in game.
  app.post("/node/players", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown; maxMeetings?: unknown; noShow?: unknown } | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const cur = fleet.nodeSettings.get().players;
    // maxMeetings null: one per bot the node can have online.
    const next = nodeSettingsLib.normalizePlayers({ enabled: typeof body.enabled === "boolean" ? body.enabled : cur.enabled, maxMeetings: "maxMeetings" in body ? body.maxMeetings : cur.maxMeetings, noShow: body.noShow ?? cur.noShow });
    fleet.nodeSettings.update((s) => { s.players = next; });
    fleet.log(`players: trades with players on the hub ${next.enabled ? `on, up to ${next.maxMeetings ?? "one per bot online"} at once` : "off"}; ${next.noShow.limit ? `${next.noShow.limit} no-show${next.noShow.limit === 1 ? "" : "s"} in a day pause a player ${next.noShow.pauseHours} h` : "no-shows pause nobody"}`);
    void fleet.hub.sendHeartbeat();
    return c.json({ ok: true, players: playersView() });
  });
  // Advanced management (docs/relay/ADVANCED.md): separately for standard and communism accounts, off by default.
  app.post("/node/advanced", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    for (const k of ["pool", "communism", "passSurplus"]) if (k in body && typeof body[k] !== "boolean") return c.json({ error: `${k} must be a boolean` }, 400);
    const cur = fleet.nodeSettings.get().advanced;
    const next = nodeSettingsLib.normalizeAdvanced({ ...cur, ...body });
    fleet.nodeSettings.update((s) => { s.advanced = next; });
    const on = (b: boolean) => (b ? "on" : "off");
    fleet.log(`advanced management: standard accounts ${on(next.pool)}, communism ${on(next.communism)}; woken merges ${next.mergeBudget === "unlimited" ? "as often as they help" : "tied to demand"}, linger ${next.lingerS} s${next.communism ? `, communism surplus ${next.passSurplus ? "passed to other nodes" : "kept"}` : ""}`);
    void fleet.hub.sendHeartbeat();
    return c.json({ ok: true, advanced: next });
  });
  // The login desk: a bot kept in game all the time, or (the default) one that logs in only while someone logs in.
  app.post("/node/login-desk", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { alwaysOn?: unknown } | null;
    if (!body || typeof body.alwaysOn !== "boolean") return c.json({ error: "alwaysOn must be a boolean" }, 400);
    const alwaysOn = body.alwaysOn;
    fleet.nodeSettings.update((s) => { s.loginDesk = { alwaysOn }; });
    fleet.log(`login desk: ${alwaysOn ? "kept in game all the time" : "staffed only while someone is logging in"}`);
    void fleet.hub.sendHeartbeat();
    return c.json({ ok: true, loginDesk: fleet.dispatcher?.loginDeskStatus() ?? { alwaysOn, wanted: false, until: null, bot: null } });
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
      // What the account keeps beyond the character (docs/relay/STORAGE.md), in the pool like the rest.
      const stored = fleet.storage.storedFor(acc).map((s) => ({ instanceId: s.instanceId, itemId: s.itemId, enchantments: s.enchantments, where: s.where, pools: s.pools }));
      const loginChar = fleet.storage.loginCharFor(acc);
      const equipped = fleet.storage.equippedFor(acc);
      const chars = fleet.storage.charsFor(acc);
      const backpacks = { ...fleet.backpacks.viewFor(acc), banked: fleet.storage.backpacksInChests(acc), canClaimAs: { seasonal: chars.some((ch) => ch.seasonal), nonseasonal: chars.some((ch) => !ch.seasonal) } };
      const characterJobs = fleet.storage.characterJobsFor(acc);
      const activity = fleet.backpacks.activityOf(acc.guid) ?? fleet.storage.activityOf(acc.guid);
      return {
        alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, ign: igns[acc.botGuid] ?? "", server: connected ? client!.server : "",
        online: connected, inWorld: connected && client!.objectId !== -1, seasonal: acc.seasonal, suspended: acc.suspended, communism: acc.communism,
        inUse: acc.inUse, assignedKind: acc.assignedKind, assignedRequestId: acc.assignedRequestId, capacity: caps[acc.botGuid] ?? 8,
        held: items.length, lastSeen: stamps.length ? Math.max(...stamps) : null, items, lastLoginError: acc.lastLoginError, charId: acc.info.charId ?? null,
        stored, vaultReadAt: fleet.storage.visitedAt(acc), storage: fleet.storage.countsFor(acc), loginChar, equipped, chars, backpacks, activity, characterJobs,
      };
    });
    return c.json({ ok: true, total: hits.length, accounts });
  });

  return app;
}
