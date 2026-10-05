// Operator-console plumbing for /dev/*. Two responsibilities:
//
// 1. Password gate. The page sends DEV_PASSWORD via the X-Dev-Password header
//    so we can refuse non-operator traffic at the Next.js layer.
//
// 2. Pyrelay client. Earlier this file read pyrelay's JSON files directly off
//    disk via PYRELAY_DIR. That works locally but breaks on Railway where the
//    two services live in isolated containers. The new model: pyrelay runs an
//    HTTP listener (see pyrelay_http.py) and we proxy operator commands to it
//    via PYRELAY_URL with PYRELAY_AUTH. Locally PYRELAY_URL=http://localhost:8080.

import { isLocalMode } from "@/node/config";
import type { SetupView, ProxyTestResult } from "@/node/setup";
import type { NodeStatusView, StatusFacts } from "@/node/status";
import type { DiagnosticsSection } from "@/node/diagnostics";
import type { ProxyLineReport } from "@/relay/net/proxy";

export function checkDevPassword(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.DEV_PASSWORD;
  if (!expected) {
    // Local mode: the server listens on loopback only, so whoever reaches
    // the console is the owner (src/node/config.ts). Set DEV_PASSWORD to
    // gate it anyway.
    if (isLocalMode()) return { ok: true };
    return { ok: false, status: 500, error: "DEV_PASSWORD not configured" };
  }
  const got = req.headers.get("x-dev-password") ?? "";
  if (got !== expected) {
    return { ok: false, status: 401, error: "Bad password" };
  }
  return { ok: true };
}

type PyrelayResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

// When the relay runs inside this process (RELAY_EMBEDDED=1), its control
// plane is registered here and every "pyrelay" call becomes an in-memory
// request instead of a network round trip. Same handlers, same JSON.
type EmbeddedRelay = { fetch: (req: Request) => Response | Promise<Response> };
declare global {
  // eslint-disable-next-line no-var
  var __embedded_relay__: EmbeddedRelay | undefined;
}
export function registerEmbeddedRelay(app: EmbeddedRelay | undefined): void {
  globalThis.__embedded_relay__ = app;
}

// The `/pool` payload is by far the most-read thing the relay serves (every
// deposit submit, withdraw, capacity read and the live watcher), so the
// embedded fleet provides it as an object rather than through the HTTP
// shape: no serialization, no Request round trip.
type PoolProvider = () => PyrelayPool;
declare global {
  // eslint-disable-next-line no-var
  var __embedded_pool__: PoolProvider | undefined;
}
export function registerEmbeddedPool(fn: PoolProvider | undefined): void {
  globalThis.__embedded_pool__ = fn;
}

async function callPyrelay<T = unknown>(
  path: string,
  init: RequestInit = {},
  /** How long a relay on the network may take (a proxy test takes longer than the usual 5 s). */
  timeoutMs = 5000,
): Promise<PyrelayResult<T>> {
  const embedded = globalThis.__embedded_relay__;
  const auth = process.env.PYRELAY_AUTH;
  if (!auth) return { ok: false, status: 500, error: "PYRELAY_AUTH not configured" };
  if (embedded) {
    const headers = new Headers(init.headers);
    headers.set("X-Pyrelay-Auth", auth);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let res: Response;
    try {
      res = await embedded.fetch(new Request(`http://relay.local${path}`, { ...init, headers }));
    } catch (e) {
      return { ok: false, status: 502, error: `embedded relay failed: ${(e as Error).message}` };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON
    }
    if (!res.ok) return { ok: false, status: res.status, error: (body as { error?: string } | null)?.error ?? `relay returned ${res.status}` };
    return { ok: true, data: body as T };
  }
  const base = process.env.PYRELAY_URL;
  if (!base) return { ok: false, status: 500, error: "PYRELAY_URL not configured" };

  const headers = new Headers(init.headers);
  headers.set("X-Pyrelay-Auth", auth);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const url = `${base.replace(/\/$/, "")}${path}`;
  let res: Response;
  try {
    // cache: "no-store" — pyrelay is the live source of truth for bot
    // inventory and operator state. Next's default fetch cache would
    // pin stale snapshots and the website would show stale pools.
    // signal: AbortSignal.timeout(5000) — if pyrelay is unreachable the
    // default fetch hangs forever; the UI then sits on "Loading…" with
    // no error. Bail at 5s so we surface a real network error instead.
    res = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const causeMsg = err.cause?.message ?? "";
    const detail = causeMsg ? ` (cause: ${causeMsg})` : "";
    return {
      ok: false,
      status: 502,
      error: `pyrelay unreachable: ${err.message}${detail}`,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // pass — non-JSON response, we'll surface the status only
  }
  if (!res.ok) {
    const err = (body as { error?: string } | null)?.error ?? `pyrelay returned ${res.status}`;
    return { ok: false, status: res.status, error: err };
  }
  return { ok: true, data: body as T };
}

/** One item in an account's storage, as the relay's `/pool` lists it (src/relay/fleet/storage.ts StoredInstance). */
export type StoredItem = {
  instanceId: string;
  itemId: string;
  enchantments: number[];
  capturedAt: number;
  /** Container wheres name the side whose character sees them once a login said (vault, rack and gift chest are one per side); worn and quickslot items are on a character, one Nexus swap from its inventory. */
  where: import("./poolWire").StoredWhereWire;
  pools: { seasonal: boolean; nonseasonal: boolean };
};

// Pyrelay's `/pool` payload. Named (rather than inline on the method) so
// lib/pool.ts can type the projection it runs over this, and lib/liveBus.ts
// can hold a snapshot of one.
export type PyrelayPool = {
  ok: true;
  bots: Record<string, Record<string, number>>;
  capacities?: Record<string, number>;
  /** Communism accounts: slots and items over every living character of the account's side (a full one rotates to the emptiest). */
  accountRoom?: Record<string, { slots: number; used: number }>;
  /** Pool accounts' characters on the other side of the seasonal split from the one they play: room on that side (relay/controlPlane.ts). */
  acrossRoom?: Record<string, { seasonal: boolean; slots: number; used: number }>;
  /** Communism accounts' characters on the other side of the split, under advanced management: room there too (relay/controlPlane.ts). */
  communismAcross?: Record<string, { seasonal: boolean; slots: number; used: number }>;
  instances: Record<
    string,
    Record<
      string,
      {
        instanceId: string;
        itemId: string;
        enchantments: number[];
        capturedAt: number;
      }
    >
  >;
  /**
   * Per bot, what its account keeps beyond the character's trade slots
   * (docs/relay/STORAGE.md): vault chests, potion rack, gift and spoils
   * chests, and the other characters' trade slots. Each says where it is and
   * which pool halves a character of the account could carry it to. Pool
   * stock like the rest, only slower: a withdraw naming one has the fleet
   * fetch it onto a character first. Absent on an older relay.
   */
  stored?: Record<string, StoredItem[]>;
  botMeta?: Record<
    string,
    {
      ign: string;
      server: string;
      online: boolean;
      seasonal?: boolean;
      /** Realm reports the account suspended: listed for the operator, never sent anywhere. */
      suspended?: boolean;
      /** Set aside for communism (lib/communismPool.ts): its items and slots are communism's, not the pool's. */
      communism?: boolean;
    }
  >;
  /** Per pool half, the biggest trade a bot the fleet would actually send could take, and whether an empty account could be fitted with a backpack on request (embedded relay only). */
  room?: { seasonal: { largestFree: number; canMake: boolean }; nonseasonal: { largestFree: number; canMake: boolean }; /** Only while advanced management is on for communism: the biggest communism deposit each side takes now. */ communism?: { seasonal: { largestFree: number }; nonseasonal: { largestFree: number } }; /** Advanced management: whether each side takes deposits into an empty character now, so a bigger one continues on the next (false: the old way). */ continues?: { seasonal: boolean; nonseasonal: boolean; communism: { seasonal: boolean; nonseasonal: boolean } } };
};

export type NodeStatus = {
  ok: true;
  version: string;
  feed: { polling: boolean; lastFetchAt: number; lastError: string | null; info: { gameVersion: string; metadataVersion: string; updatedAt: string } | null };
  build: { build: string; known: boolean; held: boolean; reason: string | null; knownBuilds: string[]; canary: { running: boolean; last: { ok: boolean; build: string; ign?: string; seconds?: number; reason?: string } | null } };
  servers: { fetchedAt: number; stale: boolean; lastError: string | null; servers: Record<string, string> };
  telemetry: { enabled: boolean; hubUrl: string; queued: number; sent: number; lastFlushAt: number | null; lastError: string | null };
  hub: { linked: boolean; url: string | null; nodeId: string | null; email: string | null; linkedAt: number | null; lastHeartbeatAt: number | null; lastError: string | null; outdated: boolean; loginNode: boolean; version: { minNodeVersion: string; latestNodeVersion: string; downloadUrl: string; build: { gameVersion: string; knownBuilds: string[]; updatedAt: number } } | null };
  /** Trades with players on the hub (node setting). */
  /** maxMeetings null: one per bot online (onlineCap); atOnce is what that comes to now. */
  players: { enabled: boolean; maxMeetings: number | null; noShow: { limit: number; pauseHours: number }; onlineCap: number; atOnce: number };
  /** The login desk: kept in game all the time (node setting), or staffed while someone logs in (`wanted`, until when), and the bot at it now. */
  loginDesk: { alwaysOn: boolean; wanted: boolean; until: number | null; bot: string | null };
  /** The hub's login node duty: sign-in codes this node's login desk is holding, and how many it has passed on. */
  realmLogins: { active: boolean; pending: number; served: number; lastError: string | null };
  /** Advanced management (node setting), separately for standard and communism accounts. */
  advanced: import("@/node/settings").AdvancedManagement;
  /** What advanced management is doing: empty characters per pool side ("p|s" standard seasonal, "c|n" communism non-seasonal…), work done since start, logins minted and reused. */
  advancedStatus?: { intake?: Record<string, { empties: number; room: number; largest: number }>; counts?: Record<string, number>; pendingMoves?: number; onlineTrips?: number; logins?: { minted: number; reused: number; reuseFailed: number } };
};

export type ProxiesPayload = {
  ok: true;
  /** Enabled distinct hosts, or null when no list is loaded at all. */
  capacity: number | null;
  inUse: number;
  /** Logins only through a proxy (node setting). */
  required: boolean;
  /** When the owner allowed logins from this computer's own internet, confirming the risk (null: not that way). */
  ownInternetAt?: number | null;
  /** The list as text, for the console's paste box. */
  text: string;
  proxies: {
    host: string;
    port: number;
    type: 4 | 5;
    username: string;
    password: string;
    enabled: boolean;
    ok: number;
    fail: number;
    benched: boolean;
    benchedUntil: number | null;
    /** Benched because Realm banned this exit IP. */
    banned?: boolean;
    inUse: boolean;
    /** Alias of the bot on this host, or null. */
    usedBy: string | null;
  }[];
};

export const pyrelay = {
  // `capacities` maps bot_guid -> trade-slot count (8 without a backpack,
  // 16 with). Older pyrelay builds omit it; treat a missing bot as 8.
  // `instances` is keyed by bot_guid -> slotIndex (string) -> per-physical-item
  // record. Slot index is 0..19 (4 equip + 8 main + 8 backpack); only occupied
  // slots are listed. `botMeta` is keyed by bot_guid -> {ign, server, online};
  // older pyrelay builds may omit it. The website projects this into
  // /api/pool's per-instance shape on every request — pyrelay is the source
  // of truth for inventory and the website holds no copy.
  pool: async (): Promise<PyrelayResult<PyrelayPool>> => {
    const local = globalThis.__embedded_pool__;
    if (local) {
      try {
        return { ok: true, data: local() };
      } catch (e) {
        return { ok: false, status: 500, error: `embedded pool failed: ${(e as Error).message}` };
      }
    }
    return callPyrelay<PyrelayPool>("/pool");
  },
  // Live inventories of the ONLINE fleet, for the dev console's Inventories
  // tab. Deliberately not `pool()`: that describes every bot ever seen with
  // full per-slot instance data and is fetched once per page load, while this
  // is polled on a timer and only covers bots that are up right now.
  //
  // Pass the `rev` from the previous response as `since` — an unchanged fleet
  // replies `{ unchanged: true }` with no `bots` array, so a quiet fleet costs
  // a round trip and nothing else.
  inventories: (since?: string) =>
    callPyrelay<{
      ok: true;
      rev: string;
      unchanged?: boolean;
      capturedAt?: number;
      bots?: {
        guid: string;
        alias: string;
        ign: string;
        server: string;
        seasonal: boolean;
        // "deposit" | "withdraw" | "consolidate_give" | "consolidate_take",
        // or null when the bot is idle.
        assigned: string | null;
        partner: string | null;
        // False while the bot is connected but hasn't loaded a character yet
        // (login queue, nexus load).
        inWorld: boolean;
        activity?: string | null;
        capacity: number;
        held: number;
        free: number;
        // Epoch seconds of the last live verification, or null if never swept.
        verifiedAt: number | null;
        items: Record<string, number>;
        // The other side of an open trade window, or null when no trade is
        // open. Items are the partner's WHOLE window — including slots they
        // haven't offered and slots Realm won't let them offer — identified
        // by raw Realm type id, since a player can bring anything in the game
        // and the catalog only knows what this site trades.
        trade: {
          ign: string;
          phase: string;
          items: {
            slot: number;
            realmId: number;
            tradeable: boolean;
            enchantment: string;
            offered: boolean;
          }[];
        } | null;
      }[];
    }>(`/inventories${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  // Pool-wide operator settings. Currently one knob — `pool_has_backpack`,
  // an override that forces the dispatcher to treat every bot as having a
  // 16-slot backpack when in-game auto-detect is unreliable.
  settings: () =>
    callPyrelay<{ ok: true; settings: { pool_has_backpack?: boolean } }>("/settings"),
  setSettings: (patch: { pool_has_backpack?: boolean }) =>
    callPyrelay<{ ok: true; settings: { pool_has_backpack?: boolean } }>("/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  // Exit IPs. `proxies` lists every host the relay knows with its operator
  // switch, health tallies and who is on it; `setProxyEnabled` flips one
  // host (or every host when `host` is null); `setProxyList` replaces the
  // list with the one the owner pasted. A disabled host is simply never
  // handed out again — a bot already connected through it keeps its session.
  proxies: () => callPyrelay<ProxiesPayload>("/proxies"),
  setProxyEnabled: (host: string | null, enabled: boolean) =>
    callPyrelay<ProxiesPayload>("/proxies", { method: "POST", body: JSON.stringify({ host, enabled }) }),
  setProxyList: (text: string) => callPyrelay<ProxiesPayload & { saved: { count: number; error: string | null }; lines: ProxyLineReport[] }>("/proxies/list", { method: "POST", body: JSON.stringify({ text }) }),
  /** A pasted list read without saving it: per line, the address it names or why it can't be used (src/relay/net/proxy.ts). */
  parseProxies: (text: string) => callPyrelay<{ ok: true; count: number; lines: ProxyLineReport[] }>("/proxies/parse", { method: "POST", body: JSON.stringify({ text }) }),
  /** Check listed proxies (all, or the hosts named), 4 at a time, up to 10 s each. */
  testProxies: (hosts?: string[]) => callPyrelay<{ ok: true; results: ProxyTestResult[] }>("/proxies/test", { method: "POST", body: JSON.stringify(hosts?.length ? { hosts } : {}) }, 15 * 60_000),
  /** Logins from this computer's own internet when no proxy is listed; allowing needs the owner's confirmation of the risk. */
  setOwnInternet: (allow: boolean, acknowledged: boolean) => callPyrelay<ProxiesPayload>("/proxies/own-internet", { method: "POST", body: JSON.stringify({ allow, acknowledged }) }),
  setProxyRequired: (required: boolean) => callPyrelay<ProxiesPayload>("/proxies/required", { method: "POST", body: JSON.stringify({ required }) }),
  // Backpacks (docs/relay/BACKPACKS.md): the fleet's /backpacks routes, reached
  // the same way as everything else. `path` is relative to /backpacks.
  backpacksPost: <T = unknown>(path: string, body: unknown = {}) =>
    callPyrelay<T>(`/backpacks${path}`, { method: "POST", body: JSON.stringify(body) }),
  // Roster intake and node status (design doc §8), see src/relay/controlPlane.ts.
  /** Log accounts in and read their inventories now (docs: a new account's first look, or a fresh one). */
  sweepAccounts: (guids: string[]) => callPyrelay<{ ok: true; results: { alias: string; botGuid: string; verdict: string }[] }>("/accounts/sweep", { method: "POST", body: JSON.stringify({ guids }) }),
  addRosterAccount: (acc: { email: string; password: string; seasonal: boolean; alias?: string }) =>
    callPyrelay<{ ok: true; where: "roster" | "onboarding"; seasonal: boolean; account?: { alias: string; guid: string; botGuid: string; seasonal: boolean | null }; detected: { tutorialDone: boolean; chars: number; loaded: { id: number; seasonal: boolean; backpackSlots: number } | null } | null }>("/accounts", { method: "POST", body: JSON.stringify(acc) }),
  // Account storage (docs/relay/STORAGE.md): the fleet's /storage routes. `path` is relative to /storage.
  storageGet: <T = unknown>(path: string) => callPyrelay<T>(`/storage${path}`),
  storagePost: <T = unknown>(path: string, body: unknown = {}) => callPyrelay<T>(`/storage${path}`, { method: "POST", body: JSON.stringify(body) }),
  // Accepted items (src/lib/itemPolicy.ts): what this node takes in.
  itemPolicyGet: () => callPyrelay<{ ok: true; policy: import("./itemPolicy").ItemPolicy; accepted: number; total: number; everything: boolean }>("/node/items"),
  itemPolicySet: (policy: unknown) => callPyrelay<{ ok: true; policy: import("./itemPolicy").ItemPolicy; accepted: number; total: number; everything: boolean }>("/node/items", { method: "POST", body: JSON.stringify({ policy }) }),
  setPreferredChar: (guid: string, charId: number | null) => callPyrelay<{ ok: true; guid: string; botGuid: string; charId: number | null }>("/accounts/char", { method: "POST", body: JSON.stringify({ guid, charId }) }),
  /** Move an account into or out of communism. */
  setAccountCommunism: (guid: string, communism: boolean) => callPyrelay<{ ok: true; guid: string; botGuid: string; communism: boolean }>("/accounts/communism", { method: "POST", body: JSON.stringify({ guid, communism }) }),
  retrySuspended: (guids?: string[]) => callPyrelay<{ ok: true; cleared: number; results: { alias: string; guid: string; botGuid: string; verdict: string; detail: string }[] }>("/accounts/retry-suspended", { method: "POST", body: JSON.stringify({ guids }) }),
  nodeStatus: () => callPyrelay<NodeStatus>("/node"),
  // The first-run setup, the status card and the diagnostics text (scratchpad contract "Windows-ready node").
  setup: () => callPyrelay<SetupView>("/setup"),
  setupAction: (body: { action: "complete" | "skip-hub" | "reset" | "test-login"; guid?: string }) => callPyrelay<SetupView | { ok: true; started: true }>("/setup", { method: "POST", body: JSON.stringify(body) }),
  /** The fleet's facts for the status card, and the card they make without the site's part. */
  statusFacts: () => callPyrelay<{ ok: true; facts: StatusFacts; status: NodeStatusView }>("/status"),
  diagnostics: (body: { site?: StatusFacts["site"]; extra?: DiagnosticsSection[] } = {}) => callPyrelay<{ ok: true; text: string }>("/diagnostics", { method: "POST", body: JSON.stringify(body) }, 30_000),
  /** The computer woke up: log the bots out cleanly and let the proxies back (Fleet.resume). */
  resume: () => callPyrelay<{ ok: true; stopped: number; proxies: number }>("/node/resume", { method: "POST" }),
  /** "Check again" while paused for a Realm update: the game's version feed, then the builds rotmg trade confirmed. */
  checkBuild: () => callPyrelay<{ ok: true; build: NodeStatus["build"]; message: string }>("/node/build/check", { method: "POST" }, 30_000),
  /** The newest fleet log lines (what the console shows), oldest first. */
  nodeLog: (n?: number) => callPyrelay<{ ok: true; lines: { at: number; line: string }[] }>(`/node/log${n ? `?n=${n}` : ""}`),
  buildCanary: (server?: string) => callPyrelay<{ ok: boolean; canary: unknown; build: NodeStatus["build"] }>("/node/build/canary", { method: "POST", body: JSON.stringify({ server }) }),
  buildTrust: () => callPyrelay<{ ok: true; build: NodeStatus["build"] }>("/node/build/trust", { method: "POST" }),
  setTelemetry: (enabled: boolean, hubUrl?: string) => callPyrelay<{ ok: true; telemetry: NodeStatus["telemetry"] }>("/node/telemetry", { method: "POST", body: JSON.stringify({ enabled, hubUrl }) }),
  setPlayers: (p: { enabled?: boolean; maxMeetings?: number | null; noShow?: { limit: number; pauseHours: number } }) => callPyrelay<{ ok: true; players: NodeStatus["players"] }>("/node/players", { method: "POST", body: JSON.stringify(p) }),
  setLoginDesk: (alwaysOn: boolean) => callPyrelay<{ ok: true; loginDesk: NodeStatus["loginDesk"] }>("/node/login-desk", { method: "POST", body: JSON.stringify({ alwaysOn }) }),
  setAdvanced: (a: Partial<import("@/node/settings").AdvancedManagement>) => callPyrelay<{ ok: true; advanced: NodeStatus["advanced"] }>("/node/advanced", { method: "POST", body: JSON.stringify(a) }),
  hubLink: (b: { url: string; code: string; name?: string }) => callPyrelay<{ ok: true; hub: NodeStatus["hub"] }>("/node/hub/link", { method: "POST", body: JSON.stringify(b) }),
  hubUnlink: () => callPyrelay<{ ok: true; hub: NodeStatus["hub"] }>("/node/hub/unlink", { method: "POST" }),
  hubHeartbeat: () => callPyrelay<{ ok: boolean; hub: NodeStatus["hub"] }>("/node/hub/heartbeat", { method: "POST" }),
  flushTelemetry: () => callPyrelay<{ ok: true; sent: number; telemetry: NodeStatus["telemetry"] }>("/node/telemetry/flush", { method: "POST" }),
  // Ask an online communism bot to `/tell <ign> <code>` in game. Used by the
  // cancel challenge (lib/cancelCode.ts): only someone who can read that
  // character's tells sees the code, which is what makes typing it back proof
  // that the request being cancelled is theirs. The response names the
  // sending bot so the UI can say who to expect the whisper from — a player
  // who can't check the sender can't tell it from a scam whisper.
  whisper: (ign: string, code: string) =>
    callPyrelay<{ ok: true; botGuid: string; botIgn: string }>("/whisper", {
      method: "POST",
      body: JSON.stringify({ ign, code }),
    }),
  // Player login: register a minted code that pyrelay should accept from an
  // inbound tell, and get back an online bot's IGN to show in the
  // "/tell <bot> <code>" line the player copy-pastes. The tell arriving from
  // their character is what proves control.
  registerLoginCode: (code: string) =>
    callPyrelay<{ ok: true; botGuid: string; botIgn: string }>("/login/register-code", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  // Player login, poll: has the pasted tell landed yet? "pending" until it
  // arrives, "verified" (with the sender's IGN) once it has, "expired" if the
  // window lapsed. Verified is single-use on pyrelay's side.
  loginCodeState: (code: string) =>
    callPyrelay<{ ok: true; state: "verified" | "pending" | "expired"; ign: string | null }>(
      `/login/code-state?code=${encodeURIComponent(code)}`,
    ),
  // Operator account lookup for the dev console's Accounts tab. Finds a bot by
  // alias, guid, bot_guid or in-game name and reports what's on it.
  //
  // Neither of the other two endpoints can answer this. `inventories` covers
  // ONLINE bots only, and offline is the normal state for most of the fleet.
  // `pool` covers every bot but subtracts suspended accounts, because anything
  // it lists has to be withdrawable — a retired account's items still exist,
  // they're just unreachable, and that's precisely what an operator chasing a
  // missing item needs to be told.
  //
  // `seasonal` is nullable here where /pool has to guess: /pool tags an
  // unswept bot seasonal because the grid needs a tab to put it in, while the
  // console can afford to say "unknown".
  accountLookup: (q: string, limit = 25) =>
    callPyrelay<{
      ok: true;
      total: number;
      accounts: {
        alias: string;
        guid: string;
        botGuid: string;
        ign: string;
        server: string;
        online: boolean;
        inWorld: boolean;
        seasonal: boolean | null;
        suspended: boolean;
        /** Set aside for communism: gives only what communism takes. */
        communism: boolean;
        inUse: boolean;
        assignedKind: string | null;
        assignedRequestId: number | null;
        capacity: number;
        held: number;
        // Epoch SECONDS of the newest capture on the account (pyrelay's clock),
        // or null if nothing was ever recorded. How stale this picture is.
        lastSeen: number | null;
        /** Why the last bring-up did not get it in world, until one does. */
        lastLoginError: { at: number; kind: string; message: string } | null;
        /** What the account keeps beyond the character (docs/relay/STORAGE.md); absent on an older relay. */
        stored?: { instanceId: string; itemId: string; enchantments: number[]; where: StoredItem["where"]; pools: StoredItem["pools"] }[];
        /** When its containers were last read (ms), null = never. */
        vaultReadAt?: number | null;
        /** What each character wears: the four equipment slots per character, catalog items or not (never pool stock). */
        equipped?: { charId: number; className: string; level: number; seasonal: boolean; slots: { slot: number; type: number; itemId: string | null; name: string; tradeable: boolean }[] }[];
        /** The character the account logs in as (storage's loginCharId with the char list's class, level and side). */
        loginChar?: { id: number; className: string; level: number; seasonal: boolean | null } | null;
        /** Every living character with its side and trade slots (StorageService.charsFor), the played one first. */
        chars?: { id: number; className: string; level: number; seasonal: boolean; login: boolean; held: number; capacity: number }[];
        /** The backpack calendar and chests (BackpackService.viewFor + StorageService.backpacksInChests). */
        backpacks?: {
          claimable: number;
          claimableDays: { track: string; day: number; quantity: number }[];
          pending: { track: string; day: number; current: number; quantity: number } | null;
          calendarAt: number | null;
          loginToday: boolean;
          job: { kind: "claim" | "consume"; charId: number | null; since: number } | null;
          lastJob: { kind: "claim" | "consume"; charId: number | null; at: number; ok: boolean; summary: string } | null;
          banked: { seasonal: number; nonseasonal: number; unknown: number };
          /** Whether the account has a living character of each side to claim with (the reward lands in that side's gift chest). */
          canClaimAs: { seasonal: boolean; nonseasonal: boolean };
        };
        /** What a maintenance service is doing with the account right now (a backpack job, a storage read), for the roster. */
        activity?: string | null;
        /** Characters queued for deletion, and how the last character job went. */
        characterJobs?: { deleteQueue: number[]; deleting?: number | null; last: { kind: "delete"; charId: number; at: number; ok: boolean; summary: string } | null; recent?: { kind: "delete"; charId: number; at: number; ok: boolean; summary: string }[]; dropQueue: string[]; lastDrop: { at: number; ok: boolean; dropped: number; planned: number; summary: string } | null };
        /** Per-container and per-side counts (StorageService.countsFor), for the roster. */
        storage?: {
          character: { held: number; capacity: number };
          vault: { used: number; slots: number };
          rack: { used: number; slots: number };
          gift: { items: number; tradeable: number };
          spoils: { items: number; tradeable: number };
          containersSide: boolean | null;
          otherSide: { seasonal: boolean; at: number; vault: { used: number; slots: number }; rack: { used: number; slots: number }; gift: { items: number; tradeable: number } } | null;
          otherChars: number;
          chars: { slots: number | null; created: number };
          sides: { seasonal: { chars: number; held: number; capacity: number }; nonseasonal: { chars: number; held: number; capacity: number } };
        };
        charId: number | null;
        items: {
          slot: number;
          instanceId: string;
          itemId: string;
          enchantments: number[];
          capturedAt: number | null;
        }[];
      }[];
    }>(`/account?q=${encodeURIComponent(q)}&limit=${limit}`),
  /** Take an account off the roster. */
  removeAccount: (guid: string) => callPyrelay<{ ok: true; guid: string; botGuid: string; alias: string }>("/accounts/remove", { method: "POST", body: JSON.stringify({ guid }) }),
  setAccountCredentials: (guid: string, creds: { email?: string; password?: string }) =>
    callPyrelay<{ ok: true; saved: true; botGuid: string; note?: string; detected?: { tutorialDone: boolean; chars: number; loaded: { id: number; seasonal: boolean } | null } }>("/accounts/credentials", { method: "POST", body: JSON.stringify({ guid, ...creds }) }),
};

// The swap coordinator (src/node/swaps.ts) runs in this process too.
type EmbeddedSwaps = import("@/node/swaps").SwapCoordinator;
declare global {
  // eslint-disable-next-line no-var
  var __embedded_swaps__: EmbeddedSwaps | undefined;
}
export function registerEmbeddedSwaps(s: EmbeddedSwaps | undefined): void {
  globalThis.__embedded_swaps__ = s;
}
export function swaps(): EmbeddedSwaps | null {
  return globalThis.__embedded_swaps__ ?? null;
}
// Hub requests (src/node/requests.ts): what hub users ask this node to do.
type EmbeddedRequests = import("@/node/requests").RequestRunner;
declare global {
  // eslint-disable-next-line no-var
  var __embedded_requests__: EmbeddedRequests | undefined;
}
export function registerEmbeddedRequests(r: EmbeddedRequests | undefined): void {
  globalThis.__embedded_requests__ = r;
}
export function hubRequests(): EmbeddedRequests | null {
  return globalThis.__embedded_requests__ ?? null;
}
// Communism (src/node/communism.ts).
type EmbeddedCommunism = import("@/node/communism").CommunismCoordinator;
declare global {
  // eslint-disable-next-line no-var
  var __embedded_communism__: EmbeddedCommunism | undefined;
}
export function registerEmbeddedCommunism(c: EmbeddedCommunism | undefined): void {
  globalThis.__embedded_communism__ = c;
}
export function communism(): EmbeddedCommunism | null {
  return globalThis.__embedded_communism__ ?? null;
}

