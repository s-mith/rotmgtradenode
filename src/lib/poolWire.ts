// The pool as it crosses the wire between the site and the browser, and the
// browser-side state it is applied to. Shared by the server (which builds the
// messages, see lib/poolSnapshot.ts) and the client (components/Vault.tsx), so
// it must stay free of Node imports.
//
// Version 2 replaced a flat per-instance list. That list repeated the bot's
// guid, IGN, server and pool flag, the item name, every enchant name and the
// rarity on each of ~50k instances: 13.5 MB per request, re-downloaded by every
// open tab on every fleet inventory change, and that one endpoint was almost
// all of the site's egress (2026-09-10). Here an instance is an
// [instanceId, itemId, enchantIds] triple under its bot, names travel once in
// dictionaries, and a tab that already holds revision R asks for `?since=R`
// and gets only the bots that changed since.

export const POOL_WIRE_VERSION = 2 as const;

export type Rarity = "common" | "uncommon" | "rare" | "legendary" | "divine";
export const RARITY_BY_COUNT: Rarity[] = ["common", "uncommon", "rare", "legendary", "divine"];
/** Rarity is a display grade for how many enchantments an item carries. */
export function rarityFor(enchantCount: number): Rarity {
  return RARITY_BY_COUNT[Math.min(Math.max(0, enchantCount), RARITY_BY_COUNT.length - 1)];
}

/** One occupied slot: instance id, catalog item id, enchant ids. */
export type WireSlot = [instanceId: string, itemId: string, enchantIds: number[]];
/**
 * Which pool halves an item can be handed out in: "s" seasonal, "n"
 * non-seasonal, "b" both (a vault item on an account with a character of
 * each side).
 */
export type WirePools = "s" | "n" | "b";
/**
 * One item in the account's storage (a vault chest, the potion rack, the
 * gift or spoils chest, or another character's trade slots): the slot triple
 * plus where it is, in words, and the halves it serves. Pool stock like the
 * rest, only slower: the fleet fetches it onto a character before the trade.
 */
export type WireStored = [instanceId: string, itemId: string, enchantIds: number[], where: string, pools: WirePools];

export interface WireBot {
  ign: string;
  /** Realm server the bot is on right now, "" while offline. */
  server: string;
  seasonal: boolean;
  slots: WireSlot[];
  /** What the account keeps beyond the character's trade slots; absent when nothing. */
  stored?: WireStored[];
}

export interface PoolSides {
  seasonal: boolean;
  nonseasonal: boolean;
}
export function sidesOf(p: WirePools): PoolSides {
  return { seasonal: p !== "n", nonseasonal: p !== "s" };
}
export function wirePools(p: PoolSides): WirePools {
  return p.seasonal && p.nonseasonal ? "b" : p.seasonal ? "s" : "n";
}
/** How the grid names a stored item's place. */
export function whereLabel(w: { kind: "vault" | "rack" | "gift" | "spoils"; slot: number } | { kind: "char"; charId: number; slot: number; className: string; level: number }): string {
  switch (w.kind) {
    case "vault": return "vault chest";
    case "rack": return "potion rack";
    case "gift": return "gift chest";
    case "spoils": return "spoils chest";
    case "char": return `${w.className} (lvl ${w.level})`;
  }
}

export interface WireCatalogEntry {
  itemId: string;
  itemName: string;
  sprite: string | null;
  category: string;
  subtype: string | null;
  /** Whether this node takes the item in (Control panel → Trading → Accepted items). */
  accepted?: boolean;
}

export interface PoolWireFull {
  v: typeof POOL_WIRE_VERSION;
  rev: string;
  full: true;
  bots: Record<string, WireBot>;
  /** itemId -> name, for every item that appears in `bots`. */
  items: Record<string, string>;
  /** enchant id -> name, for every enchant that appears in `bots` and has a name. */
  enchants: Record<string, string>;
  catalog: WireCatalogEntry[];
  /** Set when the fleet could not be reached and nothing was ever known. */
  error?: string;
}

export interface PoolWireDelta {
  v: typeof POOL_WIRE_VERSION;
  rev: string;
  /** The revision this delta applies on top of. */
  since: string;
  full: false;
  /** Bots that changed since `since`; null = the bot holds nothing visible any more. */
  bots: Record<string, WireBot | null>;
  items?: Record<string, string>;
  enchants?: Record<string, string>;
  /** Present when the deposit catalog (prices, listings) changed as well. */
  catalog?: WireCatalogEntry[];
}

export type PoolWire = PoolWireFull | PoolWireDelta;

/** What the grid renders: one record per physical item. */
export interface PoolInstance {
  instanceId: string;
  itemId: string;
  itemName: string;
  sprite: string | null;
  botGuid: string;
  botIgn: string;
  server: string;
  // Which pool holds the item: seasonal bots only trade seasonal players, so
  // the whole page views one pool at a time.
  seasonal: boolean;
  /**
   * Set on an item in the account's storage: the halves a character of the
   * account can carry it to (an item on the played character serves the
   * bot's own half, `seasonal`). Read it through `inPool`.
   */
  pools?: PoolSides;
  /** Where a stored item is, in words ("vault chest", "Wizard (lvl 20)"); absent for an item on the character, ready to trade. */
  where?: string;
  enchantments: { id: number; name: string | null }[];
  rarity: Rarity;
}

/** Whether the item can be handed out in the seasonal (`true`) or non-seasonal half. */
export function inPool(i: Pick<PoolInstance, "seasonal" | "pools">, seasonal: boolean): boolean {
  return i.pools ? (seasonal ? i.pools.seasonal : i.pools.nonseasonal) : i.seasonal === seasonal;
}

/** The browser's copy of the pool: the last applied revision and what it described. */
export interface PoolState {
  rev: string | null;
  bots: Map<string, WireBot>;
  items: Map<string, string>;
  enchants: Map<number, string>;
}

export function emptyPoolState(): PoolState {
  return { rev: null, bots: new Map(), items: new Map(), enchants: new Map() };
}

export type ApplyResult = "replaced" | "patched" | "unchanged" | "mismatch";

/**
 * Fold a message into the state. A full message replaces everything; a delta
 * whose `since` matches the state's revision patches it; a delta on any other
 * base is reported as a mismatch and left unapplied (the caller refetches in
 * full). "unchanged" is a delta that names no bots, the server's answer to
 * `since=<current>`: nothing to re-derive.
 */
export function applyPoolWire(state: PoolState, msg: PoolWire): ApplyResult {
  if (msg.full) {
    state.bots = new Map(Object.entries(msg.bots ?? {}));
    state.items = new Map(Object.entries(msg.items ?? {}));
    state.enchants = enchantMap(msg.enchants);
    state.rev = msg.rev;
    return "replaced";
  }
  if (msg.since !== state.rev) return "mismatch";
  for (const [id, name] of Object.entries(msg.items ?? {})) state.items.set(id, name);
  for (const [id, name] of enchantMap(msg.enchants)) state.enchants.set(id, name);
  let changed = false;
  for (const [guid, bot] of Object.entries(msg.bots ?? {})) {
    if (bot === null) {
      if (state.bots.delete(guid)) changed = true;
    } else {
      state.bots.set(guid, bot);
      changed = true;
    }
  }
  state.rev = msg.rev;
  return changed ? "patched" : "unchanged";
}

function enchantMap(src: Record<string, string> | undefined): Map<number, string> {
  const m = new Map<number, string>();
  for (const [k, v] of Object.entries(src ?? {})) {
    const id = Number(k);
    if (Number.isFinite(id)) m.set(id, v);
  }
  return m;
}

/**
 * The instance list the grid renders, in a stable order (item id, then
 * instance id) so tiles don't shuffle between refreshes.
 */
export function instancesFromState(state: PoolState): PoolInstance[] {
  const out: PoolInstance[] = [];
  for (const [botGuid, bot] of state.bots) {
    for (const [instanceId, itemId, enchantIds] of bot.slots) {
      const enchantments = enchantIds.map((id) => ({ id, name: state.enchants.get(id) ?? null }));
      out.push({
        instanceId,
        itemId,
        itemName: state.items.get(itemId) ?? itemId,
        sprite: null,
        botGuid,
        botIgn: bot.ign,
        server: bot.server,
        seasonal: bot.seasonal,
        enchantments,
        rarity: rarityFor(enchantments.length),
      });
    }
    for (const [instanceId, itemId, enchantIds, where, pools] of bot.stored ?? []) {
      const enchantments = enchantIds.map((id) => ({ id, name: state.enchants.get(id) ?? null }));
      const sides = sidesOf(pools);
      out.push({
        instanceId,
        itemId,
        itemName: state.items.get(itemId) ?? itemId,
        sprite: null,
        botGuid,
        botIgn: bot.ign,
        // A stored item is not on any server until fetched: a wildcard for the tray's server check.
        server: "",
        seasonal: sides.seasonal && !sides.nonseasonal ? true : !sides.seasonal && sides.nonseasonal ? false : bot.seasonal,
        pools: sides,
        where,
        enchantments,
        rarity: rarityFor(enchantments.length),
      });
    }
  }
  out.sort((a, b) => (a.itemId !== b.itemId ? a.itemId.localeCompare(b.itemId) : a.instanceId.localeCompare(b.instanceId)));
  return out;
}
