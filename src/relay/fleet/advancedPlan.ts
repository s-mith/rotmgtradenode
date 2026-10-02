// Advanced management's planner (docs/relay/ADVANCED.md): which potion stacks
// merge, which one-character bots evacuate, and which accounts want a
// compaction or a gathering run. Pure: account views in, plans out. The
// dispatcher builds the views every pass and carries the plans out; nothing
// here reads a clock, the tracker or a socket.
//
// Every rule plans inside one group, communism or standard and seasonal or
// not, and never across: pool stock never lands on a communism account and a
// seasonal item cannot cross the split. A plan names an account at most once,
// so the dispatcher can carry all of it out at the same time. Holders are
// found through an index by potion kind, never by walking pairs: a node can
// have thousands of accounts.
import { POTION_INFO, STATS } from "./potionConsolidation";

/** A stack of one potion kind smaller than this merges into a bigger holder. */
export const MERGE_UNDER = 16;
/** One-character accounts evacuate bots while fewer than this share of their group stands empty. */
export const EVACUATE_BELOW = 0.1;

/** One physical item where the view found it. */
export interface Held {
  instanceId: string;
  itemId: string;
}

/** What the planner knows about one account, built by the dispatcher from the tracker, storage and its own state. */
export interface AcctView {
  botGuid: string;
  communism: boolean;
  /** The side it plays. */
  seasonal: boolean;
  /** Living characters of that side, the played one included. */
  chars: number;
  /** In world now. */
  online: boolean;
  /** Online, unassigned, not held and not needed by players. */
  idle: boolean;
  /** Where it is (online) or was last (offline). */
  server: string | null;
  /** The played character's trade slots and what is in them; `held`: slots taken when that is more than the known items (things the tracker does not know). */
  played: { capacity: number; items: Held[]; held?: number };
  /** The vault as last seen; null when it never was. */
  vault: { slots: number; free: number; items: Held[] } | null;
  /** The other living characters of its side: `held` counts every item on one, `items` the ones known. */
  others: { charId: number; capacity: number; held: number; items: Held[] }[];
  /** Instances spoken for (open picks, offers, hand-overs): never moved, still counted. */
  reserved?: ReadonlySet<string>;
}

export interface MergeOptions {
  /** "online": two bots idle together on one server. "quiet": any pair; the dispatcher wakes what is offline. */
  mode: "online" | "quiet";
  /** Most merges to plan. */
  max: number;
  /** Accounts already taken (a move, a trip, a chore): they neither give nor take. */
  busy: ReadonlySet<string>;
  /** The most items one trade moves. */
  tradeMax: number;
}
/** One trade of potions of one kind from a small stack to a bigger one. */
export interface Merge {
  giver: string;
  taker: string;
  kind: string;
  qty: number;
  /** The giver's copies to hand over that are on its character already… */
  onCharacter: string[];
  /** …and the ones a vault fetch brings onto it first (it has the free slots for them). */
  fromVault: string[];
  /** Where the two meet: their server online; else where one of them already is, else where they were last. */
  server: string | null;
}

export interface EvacuationOptions {
  mode: "online" | "quiet";
  max: number;
  busy: ReadonlySet<string>;
  tradeMax: number;
  /** Evacuate while fewer than this share of a group's one-character bots stand empty (EVACUATE_BELOW). */
  threshold?: number;
}
/** One trade of items from a bot being emptied to a bot with room. */
export interface Move {
  giver: string;
  taker: string;
  instanceIds: string[];
  server: string | null;
}

/** The kind a potion merges by — its catalog id, one per stat and size, 16 in all — or null for anything else. */
export function kindOf(itemId: string): string | null {
  return Object.hasOwn(POTION_INFO, itemId) ? itemId : null;
}
/** Stat order, normal before greater: a fixed order for ties. */
function kindRank(kind: string): number {
  const [stat, points] = POTION_INFO[kind];
  return STATS.indexOf(stat as (typeof STATS)[number]) * 2 + points - 1;
}
/** The plan's group: communism or standard, seasonal or not. Nothing moves between groups. */
export function groupKey(a: Pick<AcctView, "communism" | "seasonal">): string {
  return `${a.communism ? "communism" : "pool"}|${a.seasonal ? "seasonal" : "nonseasonal"}`;
}
/**
 * One character's worth of the vault, kept free on an account with several
 * characters as the transit compaction moves items through: its biggest
 * character's slots. A one-character account keeps none.
 */
export function transitReserve(a: AcctView): number {
  if (a.chars < 2) return 0;
  return Math.max(a.played.capacity, ...a.others.map((o) => o.capacity));
}
/** Potions the account holds anywhere: the warehouse tie-break (deposits go to the account holding the most). */
export function potionCount(a: AcctView): number {
  let n = 0;
  for (const i of a.played.items) if (kindOf(i.itemId)) n++;
  for (const i of a.vault?.items ?? []) if (kindOf(i.itemId)) n++;
  for (const o of a.others) for (const i of o.items) if (kindOf(i.itemId)) n++;
  return n;
}
/** Slots the played character has taken: its known items, or more when the view says so. */
export function occupied(a: AcctView): number {
  return Math.max(a.played.items.length, a.played.held ?? 0);
}
/** An empty character to take a deposit: the played one, or another of its side holding nothing. */
export function hasEmptyChar(a: AcctView): boolean {
  return occupied(a) === 0 || a.others.some((o) => o.held === 0);
}

/**
 * The character compaction would empty: the emptiest one whose items are all
 * known, none spoken for, and fit on the account's other characters (charId
 * null: the played one). Null when there is none, or the vault has no slot to
 * carry them across.
 */
export function compactionSource(a: AcctView): { charId: number | null; held: number } | null {
  if (!a.vault || a.vault.free <= 0) return null;
  const chars = [{ charId: null as number | null, capacity: a.played.capacity, held: occupied(a), items: a.played.items }, ...a.others];
  const free = chars.reduce((n, c) => n + Math.max(0, c.capacity - c.held), 0);
  let best: { charId: number | null; held: number } | null = null;
  for (const c of chars) {
    if (c.held <= 0 || c.items.length < c.held || (best && c.held >= best.held)) continue;
    if (c.items.some((i) => a.reserved?.has(i.instanceId))) continue;
    if (free - Math.max(0, c.capacity - c.held) < c.held) continue;
    best = { charId: c.charId, held: c.held };
  }
  return best;
}
/**
 * An account with several characters, none of them empty, that banking cannot
 * fix (the vault cannot take the played character's items without eating into
 * the transit reserve, or some of them are spoken for) and compaction can.
 */
export function compactionWanted(a: AcctView): boolean {
  if (a.chars < 2 || !a.vault || hasEmptyChar(a)) return false;
  const fixed = a.played.items.some((i) => a.reserved?.has(i.instanceId));
  if (!fixed && a.vault.free - transitReserve(a) >= occupied(a)) return false;
  return compactionSource(a) !== null;
}
/** Potions sit on a character the account does not play, and the vault has room for them beyond the transit reserve. */
export function gatherWanted(a: AcctView): boolean {
  if (!a.vault || a.vault.free - transitReserve(a) <= 0) return false;
  return a.others.some((o) => o.items.some((i) => kindOf(i.itemId) !== null && !a.reserved?.has(i.instanceId)));
}

// --- merges -----------------------------------------------------------------------------

interface Stack {
  /** Every copy on the character and in the vault, spoken-for ones included. */
  count: number;
  /** Copies free to move, by instance id. */
  onCharacter: string[];
  inVault: string[];
}
interface Prep {
  a: AcctView;
  playedFree: number;
  /** Room for potions in the long run: the character's free slots, and the vault's beyond the transit reserve. */
  room: number;
  potions: number;
  stacks: Map<string, Stack>;
}
interface Candidate {
  merge: Merge;
  online: number;
  /** 1 when the merge leaves the giver without the kind: one stack fewer. */
  saving: number;
  stack: number;
  rank: number;
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function prepare(a: AcctView): Prep {
  const stacks = new Map<string, Stack>();
  const add = (i: Held, where: "onCharacter" | "inVault") => {
    const kind = kindOf(i.itemId);
    if (!kind) return;
    let s = stacks.get(kind);
    if (!s) stacks.set(kind, (s = { count: 0, onCharacter: [], inVault: [] }));
    s.count++;
    if (!a.reserved?.has(i.instanceId)) s[where].push(i.instanceId);
  };
  for (const i of a.played.items) add(i, "onCharacter");
  for (const i of a.vault?.items ?? []) add(i, "inVault");
  for (const s of stacks.values()) {
    s.onCharacter.sort();
    s.inVault.sort();
  }
  const playedFree = Math.max(0, a.played.capacity - occupied(a));
  const vaultRoom = a.vault ? Math.max(0, a.vault.free - transitReserve(a)) : 0;
  return { a, playedFree, room: playedFree + vaultRoom, potions: potionCount(a), stacks };
}

/** An account a plan may use: not taken, not doing player work, and in world when the plan needs it there. */
function usable(a: AcctView, mode: "online" | "quiet", busy: ReadonlySet<string>): boolean {
  if (busy.has(a.botGuid) || (a.online && !a.idle)) return false;
  return mode === "quiet" || (a.online && a.idle && !!a.server);
}
/** Where a pair meets: the server of one already in world (the taker's first), else where they were last. */
function meetingServer(giver: AcctView, taker: AcctView): string | null {
  for (const a of [taker, giver]) if (a.online && a.server) return a.server;
  return taker.server ?? giver.server ?? null;
}

/**
 * Merges for this pass. Per group and potion kind, a stack under MERGE_UNDER
 * goes to the biggest holder of the kind above it that has room for all of it
 * (potions flow uphill only: the biggest holder never gives). One trade moves
 * what the taker's character has free slots for, up to `tradeMax`, copies on
 * the giver's character first and then ones its free slots can fetch from its
 * vault; what is left waits for a later pass. Online mode pairs bots idle
 * together on one server; quiet mode any pair, those with bots already online
 * first. Then merges that clear a whole stack, then the smallest stacks.
 */
export function planMerges(accts: readonly AcctView[], o: MergeOptions): Merge[] {
  if (o.max <= 0 || o.tradeMax <= 0) return [];
  // Online, a pair must stand on the same server: each server of a group is a world of its own.
  const worlds = new Map<string, Prep[]>();
  for (const a of accts) {
    if (!usable(a, o.mode, o.busy)) continue;
    const key = o.mode === "online" ? `${groupKey(a)}|${a.server}` : groupKey(a);
    let w = worlds.get(key);
    if (!w) worlds.set(key, (w = []));
    w.push(prepare(a));
  }
  const candidates: Candidate[] = [];
  for (const key of [...worlds.keys()].sort()) mergeCandidates(worlds.get(key)!, o, candidates);
  candidates.sort((x, y) => (o.mode === "quiet" ? y.online - x.online : 0) || y.saving - x.saving || x.stack - y.stack || x.rank - y.rank || cmp(x.merge.giver, y.merge.giver));
  const used = new Set<string>();
  const out: Merge[] = [];
  for (const c of candidates) {
    if (out.length >= o.max) break;
    // The taker this stack belongs with is in another merge: it waits rather than seed a smaller holder.
    if (used.has(c.merge.giver) || used.has(c.merge.taker)) continue;
    used.add(c.merge.giver);
    used.add(c.merge.taker);
    out.push(c.merge);
  }
  return out;
}

/** Each small stack's merge in one world, into the biggest holder above it with room for it. */
function mergeCandidates(world: Prep[], o: MergeOptions, out: Candidate[]): void {
  const byKind = new Map<string, Prep[]>();
  for (const p of world) {
    for (const kind of p.stacks.keys()) {
      let hs = byKind.get(kind);
      if (!hs) byKind.set(kind, (hs = []));
      hs.push(p);
    }
  }
  for (const [kind, holders] of byKind) {
    if (holders.length < 2) continue;
    const countOf = (p: Prep) => p.stacks.get(kind)!.count;
    holders.sort((x, y) => countOf(y) - countOf(x) || y.potions - x.potions || cmp(x.a.botGuid, y.a.botGuid));
    // Givers by the room they need, least first: a taker without room for
    // one has none for any later one, and leaves the scan for good.
    const givers: { pos: number; need: number; staged: number }[] = [];
    holders.forEach((p, pos) => {
      const s = p.stacks.get(kind)!;
      if (s.count >= MERGE_UNDER) return;
      const need = s.onCharacter.length + s.inVault.length;
      const staged = s.onCharacter.length + Math.min(s.inVault.length, p.playedFree);
      if (need > 0 && staged > 0) givers.push({ pos, need, staged });
    });
    if (!givers.length) continue;
    givers.sort((x, y) => x.need - y.need || x.pos - y.pos);
    // next[i]: the first holder at or after i still worth asking (skip pointers, halved as they are followed).
    // A taker needs a free slot on its character for the trade itself.
    const next = holders.map((p, i) => (p.playedFree >= 1 ? i : i + 1));
    next.push(holders.length);
    const find = (i: number): number => {
      while (next[i] !== i) {
        next[i] = next[next[i]];
        i = next[i];
      }
      return i;
    };
    for (const g of givers) {
      let t = find(0);
      while (t < g.pos && holders[t].room < g.need) {
        next[t] = t + 1;
        t = find(t + 1);
      }
      if (t >= g.pos) continue;
      const giver = holders[g.pos];
      const taker = holders[t];
      const s = giver.stacks.get(kind)!;
      const qty = Math.min(g.staged, taker.playedFree, o.tradeMax);
      const onCharacter = s.onCharacter.slice(0, qty);
      const fromVault = s.inVault.slice(0, qty - onCharacter.length);
      out.push({
        merge: { giver: giver.a.botGuid, taker: taker.a.botGuid, kind, qty, onCharacter, fromVault, server: o.mode === "online" ? giver.a.server : meetingServer(giver.a, taker.a) },
        online: Number(giver.a.online) + Number(taker.a.online),
        saving: s.count === qty ? 1 : 0,
        stack: s.count,
        rank: kindRank(kind),
      });
    }
  }
}

// --- evacuation -------------------------------------------------------------------------

/** Per group of one-character accounts: how many there are and how many stand empty (the evacuation trigger). */
export function emptyBots(accts: readonly AcctView[]): Map<string, { accounts: number; empty: number }> {
  const out = new Map<string, { accounts: number; empty: number }>();
  for (const a of accts) {
    if (a.chars !== 1) continue;
    const key = groupKey(a);
    const e = out.get(key) ?? { accounts: 0, empty: 0 };
    e.accounts++;
    if (occupied(a) === 0) e.empty++;
    out.set(key, e);
  }
  return out;
}

/**
 * Evacuations for this pass, one-character accounts only (their vault is the
 * only shelf, and a full one leaves a bot no way to take a deposit). In a
 * group where fewer than `threshold` of the bots stand empty, the least-full
 * bots hand their character's items to bots with room that hold at least as
 * much (never an empty one), the fullest first, at most `tradeMax` a trade,
 * until enough would be empty. Vault items and spoken-for ones stay.
 */
export function planEvacuation(accts: readonly AcctView[], o: EvacuationOptions): Move[] {
  if (o.max <= 0 || o.tradeMax <= 0) return [];
  const threshold = o.threshold ?? EVACUATE_BELOW;
  const groups = new Map<string, AcctView[]>();
  for (const a of accts) {
    if (a.chars !== 1) continue;
    const key = groupKey(a);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(a);
  }
  const out: Move[] = [];
  const used = new Set<string>();
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)!;
    const empty = members.filter((a) => occupied(a) === 0).length;
    if (empty >= threshold * members.length) continue;
    let wanted = Math.max(1, Math.ceil(threshold * members.length) - empty);
    const movable = new Map<string, string[]>();
    for (const a of members) movable.set(a.botGuid, a.played.items.filter((i) => !a.reserved?.has(i.instanceId)).map((i) => i.instanceId).sort());
    const ready = members.filter((a) => usable(a, o.mode, o.busy) && occupied(a) > 0);
    // Not a bot holding something the view does not know (it would never stand empty); spoken-for items leave with their trade.
    const givers = ready.filter((a) => movable.get(a.botGuid)!.length > 0 && a.played.items.length === occupied(a)).sort((x, y) => occupied(x) - occupied(y) || cmp(x.botGuid, y.botGuid));
    const takers = ready
      .filter((a) => a.played.capacity - occupied(a) > 0)
      .sort((x, y) => occupied(y) - occupied(x) || (o.mode === "quiet" ? Number(y.online) - Number(x.online) : 0) || cmp(x.botGuid, y.botGuid));
    // Online, the taker must stand on the giver's server.
    const byServer = new Map<string, AcctView[]>();
    if (o.mode === "online") {
      for (const t of takers) {
        let l = byServer.get(t.server!);
        if (!l) byServer.set(t.server!, (l = []));
        l.push(t);
      }
    }
    for (const g of givers) {
      if (wanted <= 0 || out.length >= o.max) break;
      if (used.has(g.botGuid)) continue;
      const pool = o.mode === "online" ? byServer.get(g.server!) ?? [] : takers;
      // Uphill only, like merges: a bot never fills one emptier than itself (the next pass would undo it).
      const t = pool.find((x) => x !== g && !used.has(x.botGuid) && occupied(x) >= occupied(g));
      if (!t) continue;
      const ids = movable.get(g.botGuid)!;
      const qty = Math.min(ids.length, t.played.capacity - occupied(t), o.tradeMax);
      used.add(g.botGuid);
      used.add(t.botGuid);
      out.push({ giver: g.botGuid, taker: t.botGuid, instanceIds: ids.slice(0, qty), server: o.mode === "online" ? g.server : meetingServer(g, t) });
      wanted--;
    }
  }
  return out;
}
