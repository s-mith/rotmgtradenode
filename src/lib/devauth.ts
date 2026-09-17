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
      signal: AbortSignal.timeout(5000),
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
  where: { kind: "vault" | "rack" | "gift" | "spoils"; slot: number } | { kind: "char"; charId: number; slot: number; className: string; level: number };
  pools: { seasonal: boolean; nonseasonal: boolean };
};

// Pyrelay's `/pool` payload. Named (rather than inline on the method) so
// lib/pool.ts can type the projection it runs over this, and lib/liveBus.ts
// can hold a snapshot of one.
export type PyrelayPool = {
  ok: true;
  bots: Record<string, Record<string, number>>;
  capacities?: Record<string, number>;
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
    }
  >;
  /** Per pool half, the biggest trade a bot the fleet would actually send could take, and whether an empty account could be fitted with a backpack on request (embedded relay only). */
  room?: { seasonal: { largestFree: number; canMake: boolean }; nonseasonal: { largestFree: number; canMake: boolean } };
};

export type NodeStatus = {
  ok: true;
  version: string;
  feed: { polling: boolean; lastFetchAt: number; lastError: string | null; info: { gameVersion: string; metadataVersion: string; updatedAt: string } | null };
  build: { build: string; known: boolean; held: boolean; reason: string | null; knownBuilds: string[]; canary: { running: boolean; last: { ok: boolean; build: string; ign?: string; seconds?: number; reason?: string } | null } };
  servers: { fetchedAt: number; stale: boolean; lastError: string | null; servers: Record<string, string> };
  telemetry: { enabled: boolean; hubUrl: string; queued: number; sent: number; lastFlushAt: number | null; lastError: string | null };
  hub: { linked: boolean; url: string | null; nodeId: string | null; email: string | null; linkedAt: number | null; lastHeartbeatAt: number | null; lastError: string | null; outdated: boolean; version: { minNodeVersion: string; latestNodeVersion: string; downloadUrl: string; build: { gameVersion: string; knownBuilds: string[]; updatedAt: number } } | null };
};

export type ProxiesPayload = {
  ok: true;
  source: {
    urlConfigured: boolean;
    file: string | null;
    loadedFrom: "url" | "file" | "none";
    fetchedAt: number | null;
    lastError: string | null;
    refreshing: boolean;
  };
  /** Enabled distinct hosts, or null when no list is loaded at all. */
  capacity: number | null;
  inUse: number;
  /** Logins only through a proxy (node setting). */
  required: boolean;
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
  // host (or every host when `host` is null); `refreshProxies` re-downloads
  // the list from PROXIES_URL. A disabled host is simply never handed out
  // again — a bot already connected through it keeps its session.
  proxies: () => callPyrelay<ProxiesPayload>("/proxies"),
  setProxyEnabled: (host: string | null, enabled: boolean) =>
    callPyrelay<ProxiesPayload>("/proxies", { method: "POST", body: JSON.stringify({ host, enabled }) }),
  setProxyList: (text: string) => callPyrelay<ProxiesPayload & { saved: { count: number; error: string | null } }>("/proxies/list", { method: "POST", body: JSON.stringify({ text }) }),
  setProxyRequired: (required: boolean) => callPyrelay<ProxiesPayload>("/proxies/required", { method: "POST", body: JSON.stringify({ required }) }),
  refreshProxies: () =>
    callPyrelay<ProxiesPayload & { refresh: { ok: boolean; count: number; error: string | null } }>("/proxies/refresh", { method: "POST" }),
  // Backpacks (docs/relay/BACKPACKS.md): the fleet's /backpacks routes, reached
  // the same way as everything else. `path` is relative to /backpacks.
  backpacksGet: <T = unknown>(path: string) => callPyrelay<T>(`/backpacks${path}`),
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
  retrySuspended: (guids?: string[]) => callPyrelay<{ ok: true; cleared: number; results: { alias: string; guid: string; botGuid: string; verdict: string; detail: string }[] }>("/accounts/retry-suspended", { method: "POST", body: JSON.stringify({ guids }) }),
  nodeStatus: () => callPyrelay<NodeStatus>("/node"),
  buildCanary: (server?: string) => callPyrelay<{ ok: boolean; canary: unknown; build: NodeStatus["build"] }>("/node/build/canary", { method: "POST", body: JSON.stringify({ server }) }),
  buildTrust: () => callPyrelay<{ ok: true; build: NodeStatus["build"] }>("/node/build/trust", { method: "POST" }),
  setTelemetry: (enabled: boolean, hubUrl?: string) => callPyrelay<{ ok: true; telemetry: NodeStatus["telemetry"] }>("/node/telemetry", { method: "POST", body: JSON.stringify({ enabled, hubUrl }) }),
  hubLink: (b: { url: string; email: string; password: string; name?: string }) => callPyrelay<{ ok: true; hub: NodeStatus["hub"] }>("/node/hub/link", { method: "POST", body: JSON.stringify(b) }),
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
  setAccountCredentials: (guid: string, creds: { email?: string; password?: string }) =>
    callPyrelay<{ ok: true; saved: true; botGuid: string; note?: string; detected?: { tutorialDone: boolean; chars: number; loaded: { id: number; seasonal: boolean } | null } }>("/accounts/credentials", { method: "POST", body: JSON.stringify({ guid, ...creds }) }),
};

// --- accountgen -------------------------------------------------------------
//
// Same three-way split as the relay: in-process when ACCOUNTGEN_EMBEDDED=1
// (the service registers itself at boot), HTTP via ACCOUNTGEN_URL and
// ACCOUNTGEN_AUTH when it runs standalone, and a simulator in dev when
/** The `/live` payload: what the dev console's Tutorials tab draws. */
export type AccountgenLive = {
  ok: true;
  at: number;
  status: {
    activity: string;
    lastError: string | null;
    added: number;
    tutorialsDone: number;
    tutorialsFailed: number;
    dispensed: number;
    rejectedAtDispense: number;
    readySeasonal: number;
    readyNonseasonal: number;
    backlog: number;
    walking: number;
    failed: number;
    suspended: number;
    walkBatch: number;
    loginPausedMs: number;
  };
  walks: {
    email: string;
    alias: string;
    ign: string;
    server: string;
    seasonal: boolean;
    stage: string;
    startedAt: number;
    progressAt: number;
    connected: boolean;
    inWorld: boolean;
    queuePos: number;
    map: string;
    hp: number;
    maxHp: number;
    level: number;
    pos: { x: number; y: number } | null;
    target: { x: number; y: number } | null;
    engaging: { oid: number; x: number; y: number } | null;
    entities: { oid: number; type: number; x: number; y: number; kind: string; name: string }[];
    log: { id: number; t: number; s: string }[];
    // Tile journal tail: [kind, x, y] with 0 ground, 1 no-walk, 2 wall, 3 wall gone.
    world: { epoch: number; n: number; reset: boolean; events: [number, number, number][] };
  }[];
  recent: {
    email: string;
    alias: string;
    ign: string;
    server: string;
    ok: boolean;
    stage: string;
    reason: string | null;
    elapsedMs: number;
    endedAt: number;
  }[];
};

// The onboarding service runs inside this process (src/accountgen/service.ts);
// the dev console reaches it through this registry, in memory.
type EmbeddedAccountgen = {
  live: (cursors: string | undefined) => AccountgenLive;
  addAccount: (acc: { email: string; password: string; name?: string; seasonal: boolean }) => boolean;
};
declare global {
  // eslint-disable-next-line no-var
  var __embedded_accountgen__: EmbeddedAccountgen | undefined;
}
export function registerEmbeddedAccountgen(svc: EmbeddedAccountgen | undefined): void {
  globalThis.__embedded_accountgen__ = svc;
}

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
// Shared vaults (src/node/guests.ts).
type EmbeddedGuests = import("@/node/guests").GuestCoordinator;
declare global {
  // eslint-disable-next-line no-var
  var __embedded_guests__: EmbeddedGuests | undefined;
}
export function registerEmbeddedGuests(g: EmbeddedGuests | undefined): void {
  globalThis.__embedded_guests__ = g;
}
export function guests(): EmbeddedGuests | null {
  return globalThis.__embedded_guests__ ?? null;
}
// The commons (src/node/commons.ts).
type EmbeddedCommons = import("@/node/commons").CommonsCoordinator;
declare global {
  // eslint-disable-next-line no-var
  var __embedded_commons__: EmbeddedCommons | undefined;
}
export function registerEmbeddedCommons(c: EmbeddedCommons | undefined): void {
  globalThis.__embedded_commons__ = c;
}
export function commons(): EmbeddedCommons | null {
  return globalThis.__embedded_commons__ ?? null;
}

export const accountgen = {
  /** Pass the browser's `w` cursor string straight through. */
  live: async (cursors: string | undefined): Promise<PyrelayResult<AccountgenLive>> => {
    const local = globalThis.__embedded_accountgen__;
    if (!local) return { ok: false, status: 503, error: "the onboarding service is not running (ACCOUNTGEN_EMBEDDED=1)" };
    try {
      return { ok: true, data: local.live(cursors) };
    } catch (e) {
      return { ok: false, status: 500, error: `embedded accountgen failed: ${(e as Error).message}` };
    }
  },
  /** Queue an owner-supplied account for its tutorial walk. */
  addAccount: async (acc: { email: string; password: string; name?: string; seasonal: boolean }): Promise<PyrelayResult<{ added: boolean }>> => {
    const local = globalThis.__embedded_accountgen__;
    if (!local) return { ok: false, status: 503, error: "the onboarding service is not running (ACCOUNTGEN_EMBEDDED=1)" };
    try {
      return { ok: true, data: { added: local.addAccount(acc) } };
    } catch (e) {
      return { ok: false, status: 500, error: `embedded accountgen failed: ${(e as Error).message}` };
    }
  },
};
