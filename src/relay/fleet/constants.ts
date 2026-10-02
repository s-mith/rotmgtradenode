// Fleet tuning knobs. Names and defaults match the Python dispatcher so the
// same environment keeps the same behaviour. See docs/relay/POLICIES.md.
/** A number from the environment; a value that is not one (a typo, "20s") falls back to the default rather than switching the knob off. */
const num = (name: string, dflt: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = Number(raw);
  if (Number.isFinite(v)) return v;
  console.warn(`[fleet] ${name}=${JSON.stringify(raw)} is not a number; using ${dflt}`);
  return dflt;
};
const list = (name: string, dflt: string) => (process.env[name] ?? dflt).split(",").map((s) => s.trim()).filter(Boolean);
const flag = (name: string, dflt: boolean) => ["1", "true", "yes", "on"].includes((process.env[name] ?? (dflt ? "1" : "0")).trim().toLowerCase());

export const HEARTBEAT_INTERVAL_S = 5;
export const CLAIM_INTERVAL_S = 1.5;
export const TICK_INTERVAL_S = 0.5;
export const SUPERVISE_INTERVAL_S = 2;
export const WAKE_GRACE_S = 5;
export const WAKE_RETRY_COOLDOWN_S = num("WAKE_RETRY_COOLDOWN_SECONDS", 15);
export const RECONNECT_GRACE_S = num("RECONNECT_GRACE_SECONDS", 10);
export const WAKE_STAGGER_S = num("WAKE_STAGGER_SECONDS", 0.25);
/** Optional ceiling on live bots. 0 (the default) means the proxy pool decides:
 *  one bot per enabled exit IP, so every proxy the list has can carry a bot. */
export const MAX_ONLINE_BOTS = num("MAX_ONLINE_BOTS", 0);
/** The budget with no proxy pool loaded, when every bot shares this host's IP: one account on an IP at a time, as with proxies. */
export const DIRECT_ONLINE_BOTS = num("DIRECT_ONLINE_BOTS", 1);

/** How many bots may be online at once given the proxy pool's enabled host count (null = no pool). */
export function onlineCapFor(proxyCap: number | null, maxOnline = MAX_ONLINE_BOTS, direct = DIRECT_ONLINE_BOTS): number {
  if (proxyCap === null) return maxOnline > 0 ? Math.min(maxOnline, direct) : direct;
  return maxOnline > 0 ? Math.min(maxOnline, proxyCap) : proxyCap;
}
const envNum = (name: string): number | null => (process.env[name]?.trim() ? num(name, NaN) : null);
const WAKES_OVERRIDE = envNum("MAX_WAKES_PER_TICK");
const PAIRS_OVERRIDE = envNum("CONSOLIDATION_MAX_PAIRS");
/** Wakes started in one supervise pass: as many as the online cap (one per enabled exit IP), unless MAX_WAKES_PER_TICK says otherwise. Kept in step by tieCapsToExits. */
export let MAX_WAKES_PER_TICK = WAKES_OVERRIDE ?? DIRECT_ONLINE_BOTS;
/** Consolidation pairs at once: each takes two bots, so half the online cap, unless CONSOLIDATION_MAX_PAIRS says otherwise. */
export let CONSOLIDATION_MAX_CONCURRENT = PAIRS_OVERRIDE ?? Math.max(1, Math.floor(DIRECT_ONLINE_BOTS / 2));
/** The proxy pool's enabled host count changed (null = no pool): the caps that follow it follow. */
export function tieCapsToExits(proxyCap: number | null): void {
  const cap = Math.max(1, onlineCapFor(proxyCap));
  MAX_WAKES_PER_TICK = WAKES_OVERRIDE ?? cap;
  CONSOLIDATION_MAX_CONCURRENT = PAIRS_OVERRIDE ?? Math.max(1, Math.floor(cap / 2));
}
export const DEPOSIT_DEFER_MAX_S = num("DEPOSIT_DEFER_MAX_SECONDS", 20);
export const DEPOSIT_EMPTY_WAKE_WAIT_S = num("DEPOSIT_EMPTY_WAKE_WAIT_SECONDS", 20);
export const HTTP_STATS_INTERVAL_S = num("HTTP_STATS_INTERVAL_SECONDS", 30);
export const ROUTING_FRESH_S = num("ROUTING_FRESH_SECONDS", 8);
export const PARTNER_WAIT_MAX_S = num("PARTNER_WAIT_MAX_SECONDS", 240);
/** A cross-node meeting's bot waits for the other node's bot until the hub's deadline less this margin, then fails its side (so the receipt lands before the hub's own sweep). */
export const SWAP_GIVE_UP_MARGIN_S = num("SWAP_GIVE_UP_MARGIN_SECONDS", 60);
/** While a meeting's bot waits, a note on the row's timeline this often. */
export const SWAP_WAIT_NOTE_S = num("SWAP_WAIT_NOTE_SECONDS", 60);
/** A bot working a meeting checks this often that its swap row is still open: a meeting called off meanwhile is let go. */
export const SWAP_ROW_CHECK_S = num("SWAP_ROW_CHECK_SECONDS", 5);
/** How often to say a server's work can't be fulfilled by any bot while it waits. */
export const UNFULFILLABLE_NOTE_S = num("UNFULFILLABLE_NOTE_SECONDS", 60);
/** A >8-slot deposit unclaimed this long (two supervise passes) gets a backpack bot ordered for it, whatever the room count believes. */
export const ORDER_AFTER_S = num("ORDER_AFTER_SECONDS", 5);
/**
 * A bot that meets a server's login queue leaves it at once, and the server
 * is benched this long: the next wake, the login desk's above all, would
 * only walk into the same queue. The bench bringUp gives a server whose
 * FAILURE says its queue is full.
 */
export const LOGIN_QUEUE_BENCH_S = 45;
/** A bot woken this recently and not in world yet is about to staff the login desk: no second one is woken for it meanwhile. */
export const LOGIN_DESK_WARMUP_S = num("LOGIN_DESK_WARMUP_SECONDS", 20);
export const LOGIN_DESK_AVOID_SERVERS = new Set(list("LOGIN_DESK_AVOID_SERVERS", ""));
export const LOGIN_DESK_SERVERS = list("LOGIN_DESK_SERVERS", "USWest4,USSouth3,USMidWest2").filter((s) => !LOGIN_DESK_AVOID_SERVERS.has(s));
/**
 * The login desk (a bot in game that takes "/tell <bot> <code>" logins) is
 * staffed on demand unless the owner keeps it on (node setting): a bot logs
 * in while a code waits for its tell, stays this long after the last one,
 * then goes back to the ordinary idle rule.
 */
export const LOGIN_DESK_LINGER_S = num("LOGIN_DESK_LINGER_SECONDS", 60);
export const CONSOLIDATION_INTERVAL_S = num("CONSOLIDATION_INTERVAL_SECONDS", 5);
/** Slots of the online cap kept for players: consolidation wakes no bot for a move once no more than this many are free. */
export const CONSOLIDATION_WAKE_RESERVE = num("CONSOLIDATION_WAKE_RESERVE", 4);
export const CONSOLIDATION_ASSIGNMENT_MAX_S = num("CONSOLIDATION_ASSIGNMENT_MAX_SECONDS", 200);
export const CONSOLIDATION_ENABLED = flag("CONSOLIDATION_ENABLED", false);
export const CONSOLIDATION_SETUP_TIMEOUT_S = num("CONSOLIDATION_SETUP_TIMEOUT_SECONDS", 180);
export const CONSOLIDATION_PAIR_SETTLE_S = num("CONSOLIDATION_PAIR_SETTLE_SECONDS", 5);
export const COLLECTOR_HOLD_MAX_S = num("COLLECTOR_HOLD_MAX_SECONDS", 600);
/** After an item lands on a collector, how long it stays online for a follow-up move nobody has planned yet. */
export const COLLECTOR_GRACE_S = num("COLLECTOR_GRACE_SECONDS", 90);
export const CONSOLIDATION_RETRY_BACKOFF_S = num("CONSOLIDATION_RETRY_BACKOFF_SECONDS", 60);
/** How long a bot found full live (against the tracker's view) stays out of consolidation. */
export const CONSOLIDATION_FULL_BACKOFF_S = num("CONSOLIDATION_FULL_BACKOFF_SECONDS", 1800);
export const CONSOLIDATION_SWAPS = flag("CONSOLIDATION_SWAPS", true);
export const CONSOLIDATION_MIN_SCORE = num("CONSOLIDATION_MIN_SCORE", 2);
export const CONSOLIDATION_WAKE_COST = num("CONSOLIDATION_WAKE_COST", 2);
export const CONSOLIDATION_HOP_COST = num("CONSOLIDATION_HOP_COST", 3);
export const CONSOLIDATION_ROLE_HYSTERESIS = num("CONSOLIDATION_ROLE_HYSTERESIS", 2);
export const CONSOLIDATION_SPLIT_GREATERS = (["auto", "always", "never"].includes(process.env.CONSOLIDATION_SPLIT_GREATERS ?? "") ? process.env.CONSOLIDATION_SPLIT_GREATERS : "auto") as "auto" | "always" | "never";
export const CONSOLIDATION_METRICS_LOG_S = num("CONSOLIDATION_METRICS_LOG_SECONDS", 300);
export const DEPOSIT_COLLECTOR_WAIT_S = num("DEPOSIT_COLLECTOR_WAIT_SECONDS", 20);
export const SERVER_SWAP_GRACE_S = 3;
/** Online but not in-world for this long and the supervisor recycles the slot. */
export const IN_WORLD_TIMEOUT_S = num("IN_WORLD_TIMEOUT_SECONDS", 120);
export const FULFILL_RETRY_MAX_ATTEMPTS = num("FULFILL_RETRY_MAX_ATTEMPTS", 8);
export const FULFILL_RETRY_BACKOFF_S = num("FULFILL_RETRY_BACKOFF_SECONDS", 5);
export const FULFILL_TERMINAL_ERRORS = ["already fulfilled", "request not found", "request cancelled", "claimed by a different bot"];
export const TOKEN_ERROR_COOLDOWN_S = 20;

/** A withdraw for items in an account's storage (docs/relay/STORAGE.md): how long after a failed fetch trip before the next one, and how many trips before the request is given up. */
export const FETCH_RETRY_S = num("STORAGE_FETCH_RETRY_SECONDS", 60);
export const FETCH_MAX_ATTEMPTS = num("STORAGE_FETCH_MAX_ATTEMPTS", 3);

// --- advanced management (docs/relay/ADVANCED.md) ---------------------------------
/** A bank trip that left items behind (the vault had no room past its reserve) or failed: no other one for the account this long. */
export const ADV_BANK_BACKOFF_S = num("ADV_BANK_BACKOFF_SECONDS", 600);
/** Offline chores (compaction, gathering potions) run at most this often per account in an hour. */
export const ADV_CHORES_PER_HOUR = num("ADV_CHORES_PER_HOUR", 6);
/** How often the chores pass looks over the roster. */
export const ADV_CHORES_INTERVAL_S = num("ADV_CHORES_INTERVAL_SECONDS", 20);
/** The node has slack for chores while player requests run under this many a minute per exit IP. */
export const ADV_SLACK_PER_MIN = num("ADV_SLACK_PER_MINUTE", 1);
/** One-character accounts: below this share of empty bots, the least-full one is emptied into others (evacuation). */
export const ADV_EVACUATE_BELOW = num("ADV_EVACUATE_BELOW", 0.1);
/** How often merges and evacuations are planned. */
export const ADV_MERGE_INTERVAL_S = num("ADV_MERGE_INTERVAL_SECONDS", 10);
/** Online slots kept free for players before a quiet-period merge or evacuation wakes a pair. */
export const ADV_QUIET_RESERVE = num("ADV_QUIET_RESERVE", 1);
/** A live trip refused as busy (another trip, a storage run, a character being made): not asked again for this long. */
export const ADV_BUSY_BACKOFF_S = num("ADV_BUSY_BACKOFF_SECONDS", 30);
/** A live fetch refused as busy this long goes back to the trip with its own login. */
export const ADV_FETCH_BUSY_MAX_S = num("ADV_FETCH_BUSY_MAX_SECONDS", 30);
/** An empty character on an account locked out longer than this (bad credentials, a long cooldown) is no intake. */
export const ADV_UNUSABLE_LOCKOUT_S = num("ADV_UNUSABLE_LOCKOUT_SECONDS", 120);
/** A deposit no empty character has taken in this long: its side takes deposits the old way until it is claimed. */
export const ADV_INTAKE_FALLBACK_S = num("ADV_INTAKE_FALLBACK_SECONDS", 90);
/** How often a woken (quiet-period) merge or evacuation is planned: it walks the whole roster's storage. */
export const ADV_QUIET_PLAN_INTERVAL_S = num("ADV_QUIET_PLAN_INTERVAL_SECONDS", 60);
/** Accounts the chores pass looks at per run (it moves on through the roster from where it stopped). */
export const ADV_CHORES_SCAN = num("ADV_CHORES_SCAN", 50);
/** Characters one gathering run visits at most: it holds the account while it runs, and the rest waits for the next run. */
export const ADV_GATHER_CHARS_PER_RUN = num("ADV_GATHER_CHARS_PER_RUN", 4);
/** A chore storage found nothing to do for (its own checks said no): the account is not asked again for this long. */
export const ADV_CHORE_SKIP_BACKOFF_S = num("ADV_CHORE_SKIP_BACKOFF_SECONDS", 1800);
/**
 * Background work (gathering, compaction, woken merges and evacuations) on an
 * account only while it has logged in fewer than this many times in the last
 * 30 minutes, the run's own logins included: Realm throttles an account that
 * logs in too often. Work for players is never held back by it.
 */
export const ADV_BACKGROUND_LOGINS_PER_30MIN = num("ADV_BACKGROUND_LOGINS_PER_30MIN", 12);
