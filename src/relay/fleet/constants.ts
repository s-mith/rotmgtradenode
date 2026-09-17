// Fleet tuning knobs. Names and defaults match the Python dispatcher so the
// same environment keeps the same behaviour. See docs/relay/POLICIES.md.
const num = (name: string, dflt: number) => Number(process.env[name] ?? dflt);
const list = (name: string, dflt: string) => (process.env[name] ?? dflt).split(",").map((s) => s.trim()).filter(Boolean);
const flag = (name: string, dflt: boolean) => ["1", "true", "yes", "on"].includes((process.env[name] ?? (dflt ? "1" : "0")).trim().toLowerCase());

export const HEARTBEAT_INTERVAL_S = 5;
export const CLAIM_INTERVAL_S = 1.5;
export const TICK_INTERVAL_S = 0.5;
export const SUPERVISE_INTERVAL_S = 2;
export const WAKE_GRACE_S = 5;
export const WAKE_RETRY_COOLDOWN_S = num("WAKE_RETRY_COOLDOWN_SECONDS", 15);
export const RECONNECT_GRACE_S = num("RECONNECT_GRACE_SECONDS", 20);
export const WAKE_STAGGER_S = num("WAKE_STAGGER_SECONDS", 0.25);
/** Optional ceiling on live bots. 0 (the default) means the proxy pool decides:
 *  one bot per enabled exit IP, so every proxy the list has can carry a bot. */
export const MAX_ONLINE_BOTS = num("MAX_ONLINE_BOTS", 0);
/** The budget with no proxy pool loaded, when every bot shares this host's IP. */
export const DIRECT_ONLINE_BOTS = num("DIRECT_ONLINE_BOTS", 20);
/** How often to re-download PROXIES_URL while running, so hosts added to the
 *  list start carrying bots without a restart. 0 disables. */
export const PROXIES_REFRESH_S = num("PROXIES_REFRESH_SECONDS", 900);

/** How many bots may be online at once given the proxy pool's enabled host count (null = no pool). */
export function onlineCapFor(proxyCap: number | null, maxOnline = MAX_ONLINE_BOTS, direct = DIRECT_ONLINE_BOTS): number {
  if (proxyCap === null) return maxOnline > 0 ? Math.min(maxOnline, direct) : direct;
  return maxOnline > 0 ? Math.min(maxOnline, proxyCap) : proxyCap;
}
export const MAX_WAKES_PER_TICK = num("MAX_WAKES_PER_TICK", 10);
export const FULL_DEPOSIT_SLOTS = 8;
export const DEPOSIT_DEFER_MAX_S = num("DEPOSIT_DEFER_MAX_SECONDS", 20);
export const DEPOSIT_EMPTY_WAKE_WAIT_S = num("DEPOSIT_EMPTY_WAKE_WAIT_SECONDS", 90);
export const HTTP_STATS_INTERVAL_S = num("HTTP_STATS_INTERVAL_SECONDS", 30);
export const ROUTING_FRESH_S = num("ROUTING_FRESH_SECONDS", 8);
export const PARTNER_WAIT_MAX_S = num("PARTNER_WAIT_MAX_SECONDS", 240);
export const STANDBY_STARVED_LOG_S = num("STANDBY_STARVED_LOG_SECONDS", 120);
/** How often to say a server's work can't be fulfilled by any bot while it waits. */
export const UNFULFILLABLE_NOTE_S = num("UNFULFILLABLE_NOTE_SECONDS", 60);
/** A >8-slot deposit unclaimed this long (two supervise passes) gets a backpack bot ordered for it, whatever the room count believes. */
export const ORDER_AFTER_S = num("ORDER_AFTER_SECONDS", 5);
export const STANDBY_WAKE_GRACE_S = num("STANDBY_WAKE_GRACE_SECONDS", 30);
export const RESIDENT_EMPTY_SERVERS = new Set(list("RESIDENT_EMPTY_SERVERS", ""));
export const RESIDENT_MAX_PER_SERVER = num("RESIDENT_MAX_PER_SERVER", 8);
export const QUEUE_PROTECTED_SERVERS = new Set(list("QUEUE_PROTECTED_SERVERS", [...RESIDENT_EMPTY_SERVERS].sort().join(",")));
export const QUEUE_PROTECT_MAX_S = num("QUEUE_PROTECT_MAX_SECONDS", 420);
export const QUEUE_PROTECT_WARMUP_S = num("QUEUE_PROTECT_WARMUP_SECONDS", 20);
export const QUEUE_LOG_INTERVAL_S = num("QUEUE_LOG_INTERVAL_SECONDS", 30);
export const LOGIN_DESK_AVOID_SERVERS = new Set(
  process.env.LOGIN_DESK_AVOID_SERVERS !== undefined ? list("LOGIN_DESK_AVOID_SERVERS", "") : [...QUEUE_PROTECTED_SERVERS],
);
export const LOGIN_DESK_SERVERS = list("LOGIN_DESK_SERVERS", "USWest4,USSouth3,USMidWest2").filter((s) => !LOGIN_DESK_AVOID_SERVERS.has(s));
export const ACCOUNTGEN_PULL_COOLDOWN_S = num("ACCOUNTGEN_PULL_COOLDOWN_SECONDS", 10);
export const FREE_SLOTS_TARGET = num("FREE_SLOTS_TARGET", 128);
/** The same bound for the seasonal pool; 0 keeps the historical behaviour of pulling seasonal accounts without limit. */
export const SEASONAL_FREE_SLOTS_TARGET = num("SEASONAL_FREE_SLOTS_TARGET", 0);
export const CONSOLIDATION_INTERVAL_S = num("CONSOLIDATION_INTERVAL_SECONDS", 5);
export const CONSOLIDATION_MAX_CONCURRENT = num("CONSOLIDATION_MAX_PAIRS", 3);
export const CONSOLIDATION_WAKE_RESERVE = num("CONSOLIDATION_WAKE_RESERVE", 4);
export const CONSOLIDATION_ASSIGNMENT_MAX_S = num("CONSOLIDATION_ASSIGNMENT_MAX_SECONDS", 200);
export const CONSOLIDATION_ENABLED = flag("CONSOLIDATION_ENABLED", false);
export const CONSOLIDATION_SETUP_TIMEOUT_S = num("CONSOLIDATION_SETUP_TIMEOUT_SECONDS", 180);
export const CONSOLIDATION_PAIR_SETTLE_S = num("CONSOLIDATION_PAIR_SETTLE_SECONDS", 5);
export const COLLECTOR_HOLD_MAX_S = num("COLLECTOR_HOLD_MAX_SECONDS", 600);
/** After an item lands on a collector, how long it stays online for a follow-up move nobody has planned yet. */
export const COLLECTOR_GRACE_S = num("COLLECTOR_GRACE_SECONDS", 90);
export const CONSOLIDATION_RETRY_BACKOFF_S = num("CONSOLIDATION_RETRY_BACKOFF_SECONDS", 60);
/** How long a bot found full live (against the tracker's view) stays out of consolidation and vault packing. */
export const CONSOLIDATION_FULL_BACKOFF_S = num("CONSOLIDATION_FULL_BACKOFF_SECONDS", 1800);
export const CONSOLIDATION_SWAPS = flag("CONSOLIDATION_SWAPS", true);
export const CONSOLIDATION_MIN_SCORE = num("CONSOLIDATION_MIN_SCORE", 2);
export const CONSOLIDATION_WAKE_COST = num("CONSOLIDATION_WAKE_COST", 2);
export const CONSOLIDATION_HOP_COST = num("CONSOLIDATION_HOP_COST", 3);
export const CONSOLIDATION_ROLE_HYSTERESIS = num("CONSOLIDATION_ROLE_HYSTERESIS", 2);
export const CONSOLIDATION_SPLIT_GREATERS = (["auto", "always", "never"].includes(process.env.CONSOLIDATION_SPLIT_GREATERS ?? "") ? process.env.CONSOLIDATION_SPLIT_GREATERS : "auto") as "auto" | "always" | "never";
export const CONSOLIDATION_METRICS_LOG_S = num("CONSOLIDATION_METRICS_LOG_SECONDS", 300);
export const DEPOSIT_COLLECTOR_WAIT_S = num("DEPOSIT_COLLECTOR_WAIT_SECONDS", 20);
/** Personal storage: how often to look for owned items not yet on their owner's bot, and how many packing moves run at once. */
export const VAULT_PACK_INTERVAL_S = num("VAULT_PACK_INTERVAL_SECONDS", 5);
export const VAULT_PACK_MAX_CONCURRENT = num("VAULT_PACK_MAX_CONCURRENT", 2);
export const SERVER_SWAP_GRACE_S = 3;
/** Online but not in-world for this long and the supervisor recycles the slot. */
export const IN_WORLD_TIMEOUT_S = num("IN_WORLD_TIMEOUT_SECONDS", 120);
export const FULFILL_RETRY_MAX_ATTEMPTS = num("FULFILL_RETRY_MAX_ATTEMPTS", 8);
export const FULFILL_RETRY_BACKOFF_S = num("FULFILL_RETRY_BACKOFF_SECONDS", 5);
export const FULFILL_TERMINAL_ERRORS = ["already fulfilled", "request not found", "request cancelled", "claimed by a different bot"];
export const TOKEN_ERROR_COOLDOWN_S = 20;

/** STANDBY_BOTS: "USEast:3s+1n,EUWest:1" -> {server: {seasonality: count}}; null key = agnostic.
 *  STANDBY_BOTS_COMMUNISM is honoured as a legacy spelling from the two-site fleet. */
export function parseStandby(): Map<string, Map<boolean | null, number>> {
  const raw = process.env.STANDBY_BOTS_COMMUNISM ?? process.env.STANDBY_BOTS ?? "";
  const out = new Map<string, Map<boolean | null, number>>();
  for (const chunk of raw.split(",")) {
    const c = chunk.trim();
    if (!c) continue;
    const [serverRaw, spec = ""] = c.split(":", 2);
    const server = serverRaw.trim();
    if (!server) continue;
    const buckets = new Map<boolean | null, number>();
    for (let part of spec.split("+")) {
      part = part.trim().toLowerCase();
      if (!part) continue;
      let seas: boolean | null = null;
      if (part.endsWith("s")) { seas = true; part = part.slice(0, -1); }
      else if (part.endsWith("n")) { seas = false; part = part.slice(0, -1); }
      const n = Number(part);
      if (!Number.isInteger(n)) {
        console.log(`Dispatcher: ignoring malformed STANDBY_BOTS entry ${JSON.stringify(c)}`);
        continue;
      }
      if (n > 0) buckets.set(seas, (buckets.get(seas) ?? 0) + n);
    }
    if (buckets.size) out.set(server, buckets);
  }
  return out;
}
/** A withdraw for items in an account's storage (docs/relay/STORAGE.md): how long after a failed fetch trip before the next one, and how many trips before the request is given up. */
export const FETCH_RETRY_S = num("STORAGE_FETCH_RETRY_SECONDS", 60);
export const FETCH_MAX_ATTEMPTS = num("STORAGE_FETCH_MAX_ATTEMPTS", 3);
