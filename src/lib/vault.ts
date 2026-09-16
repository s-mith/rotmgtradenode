// Personal storage: a player's own slots on bots of their own.
//
// The pool is everyone's; a vault is one account's. Ownership lives here, in
// vault_items — THE source of truth for which physical item (tracker instance)
// belongs to whom. Everything else derives from it: the public pool is every
// tracked instance NOT in this table, capacity counts only bots that are not
// somebody's vault bot, and the fleet reads this table to pack a player's
// items onto their own bot.
//
// An account has two vaults, one per pool half, because a seasonal bot can't
// trade a non-seasonal player. users.vault_slots is the account's total; the
// player allocates it between the halves in blocks of VAULT_BLOCK (the
// vault_halves table), and each half that holds anything has its own bot.
//
// Points: a claim takes an item out of the commons and a donate puts one back,
// so they hit the ledger exactly like a withdraw and a deposit of that item.
// Moving your own property in and out of your vault (the fleet-served deposit
// and withdraw) is point-neutral and never touches the ledger.
import type Database from "better-sqlite3";
import { ITEM_BY_ID } from "./catalog";
import { enchantName } from "./enchants";
import type { PyrelayPool } from "./devauth";
import { emitTx, notifyPoolChanged } from "./liveBus";
import { checkWithdrawAllowance } from "./playerLimits";

/** Slots move between the halves this many at a time: one bot's inventory. */
export const VAULT_BLOCK = 8;

const DEFAULT_SLOTS_KEY = "vault_default_slots";

/** The entitlement a new account starts with. Moves with the fleet-wide cap (bumpAllVaultCaps). */
export function defaultVaultSlots(db: Database.Database): number {
  const r = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(DEFAULT_SLOTS_KEY) as { value: string } | undefined;
  const n = r ? Number(r.value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : VAULT_BLOCK;
}

export interface CapBumpResult {
  delta: number;
  accounts: number;
  /** The entitlement new accounts get, before and after. */
  defaultBefore: number;
  defaultAfter: number;
  /** Halves that gave up a block so the account fits its new cap. */
  shrunk: number;
  /** Accounts left holding more slots than their new cap, because every half is too full to give a block back. */
  overAllocated: { userId: number; igns: string[]; total: number; allocated: number }[];
}

/**
 * Raise or lower every account's entitlement by one block, and the default
 * for accounts to come. Raising is free: the new slots sit unallocated
 * until the player places them. Lowering takes the block from what is
 * unallocated first; failing that, from a half with a whole free block
 * (items plus wishes leave room), largest room first; failing that the
 * account stays over its cap — it can't grow either half until it is back
 * under — and is reported.
 */
export function bumpAllVaultCaps(db: Database.Database, delta: number): CapBumpResult {
  if (delta !== VAULT_BLOCK && delta !== -VAULT_BLOCK) throw new Error(`delta must be ±${VAULT_BLOCK}`);
  const now = Date.now();
  return db.transaction((): CapBumpResult => {
    const defaultBefore = defaultVaultSlots(db);
    const defaultAfter = Math.max(0, defaultBefore + delta);
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(DEFAULT_SLOTS_KEY, String(defaultAfter));
    const users = db.prepare("SELECT id, vault_slots FROM users ORDER BY id").all() as { id: number; vault_slots: number }[];
    const setCap = db.prepare("UPDATE users SET vault_slots = ? WHERE id = ?");
    const setHalf = db.prepare("UPDATE vault_halves SET slots = ? WHERE user_id = ? AND seasonal = ?");
    const ev = db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) VALUES (?, '', 'cap-changed', NULL, NULL, ?, ?)");
    let shrunk = 0;
    const overAllocated: CapBumpResult["overAllocated"] = [];
    for (const u of users) {
      const to = Math.max(0, u.vault_slots + delta);
      setCap.run(to, u.id);
      const detail: Record<string, unknown> = { from: u.vault_slots, to };
      if (delta < 0) {
        const a = vaultHalves(db, u.id);
        const allocated = a.seasonal.slots + a.nonseasonal.slots;
        if (allocated > to) {
          // Give a block back from the roomiest half that can spare one.
          const halves = [a.seasonal, a.nonseasonal]
            .map((h) => ({ h, room: h.slots - vaultCount(db, u.id, h.seasonal) - wishCount(db, u.id, h.seasonal) }))
            .filter((x) => x.h.slots >= VAULT_BLOCK && x.room >= VAULT_BLOCK)
            .sort((x, y) => y.room - x.room);
          if (halves.length) {
            const { h } = halves[0];
            setHalf.run(h.slots - VAULT_BLOCK, u.id, h.seasonal ? 1 : 0);
            if (h.slots - VAULT_BLOCK === 0) releaseVaultBotIfEmpty(db, u.id, h.seasonal);
            detail.shrunk = { seasonal: h.seasonal, slots: h.slots - VAULT_BLOCK };
            shrunk++;
          } else {
            detail.overAllocated = allocated;
            overAllocated.push({ userId: u.id, igns: ignsOfUser(db, u.id), total: to, allocated });
          }
        }
      }
      ev.run(u.id, JSON.stringify(detail), now);
    }
    return { delta, accounts: users.length, defaultBefore, defaultAfter, shrunk, overAllocated };
  }).immediate();
}

/** How many accounts sit at each cap, for the operator. */
export function vaultCapSummary(db: Database.Database): { default: number; block: number; accounts: number; byCap: { cap: number; accounts: number }[] } {
  const byCap = (db.prepare("SELECT vault_slots AS cap, COUNT(*) AS accounts FROM users GROUP BY vault_slots ORDER BY vault_slots").all() as { cap: number; accounts: number }[]);
  return { default: defaultVaultSlots(db), block: VAULT_BLOCK, accounts: byCap.reduce((n, r) => n + r.accounts, 0), byCap };
}

function ignsOfUser(db: Database.Database, userId: number): string[] {
  return (db.prepare("SELECT ign FROM user_igns WHERE user_id = ? ORDER BY linked_at, rowid").all(userId) as { ign: string }[]).map((r) => r.ign);
}

export const poolName = (seasonal: boolean) => (seasonal ? "seasonal" : "non-seasonal");

export interface VaultHalf {
  userId: number;
  seasonal: boolean;
  slots: number;
  botGuid: string | null;
  botSince: number | null;
}

export interface VaultAllocation {
  /** The account's entitlement: what the two halves share. */
  total: number;
  unallocated: number;
  seasonal: VaultHalf;
  nonseasonal: VaultHalf;
}

export interface VaultItemRow {
  instanceId: string;
  itemId: string;
  enchants: number;
  seasonal: boolean;
  botGuid: string | null;
  source: "claim" | "deposit";
  createdAt: number;
}

type Actor = { userId: number; ign: string; ignLower: string };
type HalfRow = { user_id: number; seasonal: number; slots: number; bot_guid: string | null; bot_since: number | null };

const toHalf = (r: HalfRow): VaultHalf => ({ userId: r.user_id, seasonal: r.seasonal !== 0, slots: r.slots, botGuid: r.bot_guid, botSince: r.bot_since });

/**
 * A user's two half rows, created on first touch: a new account's whole
 * entitlement sits in the seasonal half until the player moves some.
 */
function ensureHalves(db: Database.Database, userId: number): void {
  db.prepare("INSERT OR IGNORE INTO vault_halves (user_id, seasonal, slots) SELECT id, 1, vault_slots FROM users WHERE id = ?").run(userId);
  db.prepare("INSERT OR IGNORE INTO vault_halves (user_id, seasonal, slots) SELECT id, 0, 0 FROM users WHERE id = ?").run(userId);
}

export function vaultHalf(db: Database.Database, userId: number, seasonal: boolean): VaultHalf {
  ensureHalves(db, userId);
  const r = db.prepare("SELECT user_id, seasonal, slots, bot_guid, bot_since FROM vault_halves WHERE user_id = ? AND seasonal = ?").get(userId, seasonal ? 1 : 0) as HalfRow | undefined;
  if (!r) throw new Error(`no user ${userId}`);
  return toHalf(r);
}

export function vaultHalves(db: Database.Database, userId: number): VaultAllocation {
  ensureHalves(db, userId);
  const u = db.prepare("SELECT vault_slots FROM users WHERE id = ?").get(userId) as { vault_slots: number } | undefined;
  if (!u) throw new Error(`no user ${userId}`);
  const rows = db.prepare("SELECT user_id, seasonal, slots, bot_guid, bot_since FROM vault_halves WHERE user_id = ?").all(userId) as HalfRow[];
  const seasonal = toHalf(rows.find((r) => r.seasonal !== 0)!);
  const nonseasonal = toHalf(rows.find((r) => r.seasonal === 0)!);
  return { total: u.vault_slots, unallocated: Math.max(0, u.vault_slots - seasonal.slots - nonseasonal.slots), seasonal, nonseasonal };
}

export function vaultItems(db: Database.Database, userId: number): VaultItemRow[] {
  return (db.prepare("SELECT instance_id, item_id, enchants, seasonal, bot_guid, source, created_at FROM vault_items WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as {
    instance_id: string; item_id: string; enchants: number; seasonal: number; bot_guid: string | null; source: "claim" | "deposit"; created_at: number;
  }[]).map((r) => ({ instanceId: r.instance_id, itemId: r.item_id, enchants: r.enchants, seasonal: r.seasonal !== 0, botGuid: r.bot_guid, source: r.source, createdAt: r.created_at }));
}

/** Items held: in one half, or across both when `seasonal` is omitted. */
export function vaultCount(db: Database.Database, userId: number, seasonal?: boolean): number {
  if (seasonal === undefined) return (db.prepare("SELECT COUNT(*) AS n FROM vault_items WHERE user_id = ?").get(userId) as { n: number }).n;
  return (db.prepare("SELECT COUNT(*) AS n FROM vault_items WHERE user_id = ? AND seasonal = ?").get(userId, seasonal ? 1 : 0) as { n: number }).n;
}

/** Wishes pending against one half (lib/wishlist.ts); each will fill a slot. */
export function wishCount(db: Database.Database, userId: number, seasonal: boolean): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM wishlist_rules WHERE user_id = ? AND seasonal = ?").get(userId, seasonal ? 1 : 0) as { n: number }).n;
}

/** Every owned instance, for keeping private property out of the public pool. */
export function ownedInstanceIds(db: Database.Database): Set<string> {
  return new Set((db.prepare("SELECT instance_id FROM vault_items").all() as { instance_id: string }[]).map((r) => r.instance_id));
}

/** Bots dedicated to somebody's storage right now: not pool capacity. */
export function vaultBotGuids(db: Database.Database): Set<string> {
  return new Set((db.prepare("SELECT bot_guid FROM vault_halves WHERE bot_guid IS NOT NULL").all() as { bot_guid: string }[]).map((r) => r.bot_guid));
}

/** The half a vault bot serves, or null when the bot is nobody's. */
export function vaultHalfOfBot(db: Database.Database, botGuid: string): VaultHalf | null {
  const r = db.prepare("SELECT user_id, seasonal, slots, bot_guid, bot_since FROM vault_halves WHERE bot_guid = ?").get(botGuid) as HalfRow | undefined;
  return r ? toHalf(r) : null;
}

/**
 * Instances named by any open per-instance withdraw — a player's vault
 * withdraw or a pool pick. Reserved items can't be claimed, donated or moved
 * until that request ends.
 */
export function reservedInstanceIds(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT instance_ids_json FROM withdraw_requests WHERE status IN ('pending','claimed') AND instance_ids_json IS NOT NULL").all() as { instance_ids_json: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.instance_ids_json);
      if (Array.isArray(arr)) for (const id of arr) out.add(String(id));
    } catch {
      // malformed open row — the stale-request sweep will cancel it
    }
  }
  return out;
}

function openVaultRequests(db: Database.Database, userId: number, seasonal: boolean): number {
  const s = seasonal ? 1 : 0;
  return (db.prepare(
    `SELECT (SELECT COUNT(*) FROM deposit_requests WHERE vault_user_id = ? AND seasonal = ? AND status IN ('pending','claimed'))
          + (SELECT COUNT(*) FROM withdraw_requests WHERE vault_user_id = ? AND seasonal = ? AND status IN ('pending','claimed')) AS n`,
  ).get(userId, s, userId, s) as { n: number }).n;
}

function logEvent(db: Database.Database, actor: Actor, event: string, instanceId: string | null, itemId: string | null, detail: unknown, now: number): void {
  db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(actor.userId, actor.ign, event, instanceId, itemId, detail === undefined ? null : JSON.stringify(detail), now);
}

/**
 * Give a half its bot if it has none: the first candidate no other half
 * holds. Candidates come from the caller's pool snapshot (see
 * vaultBotCandidates); the UNIQUE constraint settles a race between two
 * players picking the same empty bot. Returns the bot, or null when every
 * candidate was taken (the vault still works — the fleet just has nowhere to
 * pack it yet, and the next request tries again).
 */
export function ensureVaultBot(db: Database.Database, userId: number, seasonal: boolean, candidates: string[], now: number): string | null {
  const s = seasonal ? 1 : 0;
  const cur = vaultHalf(db, userId, seasonal).botGuid;
  if (cur) return cur;
  for (const g of candidates) {
    try {
      const r = db.prepare("UPDATE vault_halves SET bot_guid = ?, bot_since = ? WHERE user_id = ? AND seasonal = ? AND bot_guid IS NULL").run(g, now, userId, s);
      if (r.changes) return g;
      return vaultHalf(db, userId, seasonal).botGuid;
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) continue;
      throw e;
    }
  }
  return null;
}

/**
 * A half's bot goes back to the pool once nothing of the user's is on it or
 * on the way. Both halves are checked when `seasonal` is omitted.
 */
export function releaseVaultBotIfEmpty(db: Database.Database, userId: number, seasonal?: boolean): boolean {
  if (seasonal === undefined) {
    const a = releaseVaultBotIfEmpty(db, userId, true);
    const b = releaseVaultBotIfEmpty(db, userId, false);
    return a || b;
  }
  if (vaultCount(db, userId, seasonal) > 0 || openVaultRequests(db, userId, seasonal) > 0) return false;
  return db.prepare("UPDATE vault_halves SET bot_guid = NULL, bot_since = NULL WHERE user_id = ? AND seasonal = ? AND bot_guid IS NOT NULL").run(userId, seasonal ? 1 : 0).changes > 0;
}

/**
 * Empty, offline, same-pool bots that are nobody's vault bot — what a new
 * vault may be given. Offline so the fleet isn't using it for something
 * right now; empty so the owner's slots are all there. A stable order with
 * a per-user offset spreads concurrent pickers over different bots.
 */
export function vaultBotCandidates(db: Database.Database, pool: PyrelayPool, seasonal: boolean, userId: number, limit = 12): string[] {
  const taken = vaultBotGuids(db);
  const meta = pool.botMeta ?? {};
  const all: string[] = [];
  for (const [g, m] of Object.entries(meta)) {
    if ((m.seasonal !== false) !== seasonal) continue;
    if (m.online || m.suspended || taken.has(g)) continue;
    const held = Object.values(pool.bots[g] ?? {}).reduce((a, b) => a + b, 0);
    if (held > 0) continue;
    all.push(g);
  }
  all.sort();
  if (!all.length) return [];
  const start = userId % all.length;
  return [...all.slice(start), ...all.slice(0, start)].slice(0, limit);
}

export type VaultResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export interface ClaimPick {
  instanceId: string;
  itemId: string;
  enchants: number;
  botGuid: string;
  seasonal: boolean;
}

/** The one pool half a set of picks lives in, or null when they straddle both. */
function halfOf(items: { seasonal: boolean }[]): boolean | null {
  const s = items[0].seasonal;
  return items.every((p) => p.seasonal === s) ? s : null;
}

/**
 * Take pool items into the vault half that holds them. Instant: ownership
 * flips here, the item stays where it physically is until the fleet moves
 * it to the half's bot. Costs points like a withdraw of each item.
 */
export function claimInstances(db: Database.Database, actor: Actor, picks: ClaimPick[], botCandidates: string[]): VaultResult<{ claimed: number; seasonal: boolean; used: number; slots: number; botGuid: string | null }> {
  if (!picks.length) return { ok: false, status: 400, error: "Pick at least 1 item." };
  const now = Date.now();
  const out = db.transaction((): VaultResult<{ claimed: number; seasonal: boolean; used: number; slots: number; botGuid: string | null }> => {
    const seasonal = halfOf(picks);
    if (seasonal === null) return { ok: false, status: 400, error: "Claim from one pool at a time — seasonal and non-seasonal items go to different vaults." };
    const h = vaultHalf(db, actor.userId, seasonal);
    if (h.slots < 1) {
      return { ok: false, status: 409, error: `You have no vault slots allocated to the ${poolName(seasonal)} pool. Allocate some from My Vault first.` };
    }
    const used = vaultCount(db, actor.userId, seasonal);
    if (used + picks.length > h.slots) {
      return { ok: false, status: 409, error: `Not enough room in your ${poolName(seasonal)} vault: ${used} of ${h.slots} slots used, ${picks.length} more won't fit.` };
    }
    const owned = db.prepare("SELECT instance_id FROM vault_items WHERE instance_id = ?");
    const reserved = reservedInstanceIds(db);
    for (const p of picks) {
      if (owned.get(p.instanceId)) return { ok: false, status: 409, error: "One of those items was just claimed by someone else. Refresh and try again." };
      if (reserved.has(p.instanceId)) return { ok: false, status: 409, error: "One of those items is reserved by an open withdraw. Refresh and try again." };
    }
    const allowance = checkWithdrawAllowance(db, actor.ignLower, picks.length);
    if (!allowance.ok) return { ok: false, status: 429, error: allowance.error };

    const tx = db.prepare("INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, enchants, server, request_id, created_at) VALUES ('withdraw', ?, ?, ?, 1, ?, NULL, NULL, ?)");
    const ins = db.prepare("INSERT INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'claim', ?)");
    for (const p of picks) {
      tx.run(actor.ign, actor.ignLower, p.itemId, p.enchants, now);
      ins.run(p.instanceId, actor.userId, p.itemId, p.enchants, seasonal ? 1 : 0, p.botGuid, now);
      logEvent(db, actor, "claimed", p.instanceId, p.itemId, { enchants: p.enchants, from: p.botGuid }, now);
    }
    const botGuid = ensureVaultBot(db, actor.userId, seasonal, botCandidates, now);
    return { ok: true, claimed: picks.length, seasonal, used: used + picks.length, slots: h.slots, botGuid };
  }).immediate();
  if (out.ok) {
    emitTx();
    notifyPoolChanged();
  }
  return out;
}

/**
 * Hand vault items back to the pool. Instant too: the item is pool stock the
 * moment its owner row goes, wherever it sits. Earns points like a deposit.
 */
export function donateInstances(db: Database.Database, actor: Actor, instanceIds: string[]): VaultResult<{ donated: number; seasonal: boolean; used: number; slots: number; released: boolean }> {
  const ids = [...new Set(instanceIds)];
  if (!ids.length) return { ok: false, status: 400, error: "Pick at least 1 item." };
  const now = Date.now();
  const out = db.transaction((): VaultResult<{ donated: number; seasonal: boolean; used: number; slots: number; released: boolean }> => {
    const reserved = reservedInstanceIds(db);
    const get = db.prepare("SELECT item_id, enchants, seasonal FROM vault_items WHERE instance_id = ? AND user_id = ?");
    const rows: { instanceId: string; itemId: string; enchants: number; seasonal: boolean }[] = [];
    for (const id of ids) {
      const r = get.get(id, actor.userId) as { item_id: string; enchants: number; seasonal: number } | undefined;
      if (!r) return { ok: false, status: 404, error: "One of those items isn't in your vault any more. Refresh and try again." };
      if (reserved.has(id)) return { ok: false, status: 409, error: "One of those items is on its way to you in an open withdraw. Cancel that first." };
      rows.push({ instanceId: id, itemId: r.item_id, enchants: r.enchants, seasonal: r.seasonal !== 0 });
    }
    const seasonal = halfOf(rows);
    if (seasonal === null) return { ok: false, status: 400, error: "Donate from one vault at a time." };
    const h = vaultHalf(db, actor.userId, seasonal);
    const tx = db.prepare("INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, enchants, server, request_id, created_at) VALUES ('deposit', ?, ?, ?, 1, ?, NULL, NULL, ?)");
    const del = db.prepare("DELETE FROM vault_items WHERE instance_id = ? AND user_id = ?");
    for (const r of rows) {
      del.run(r.instanceId, actor.userId);
      tx.run(actor.ign, actor.ignLower, r.itemId, r.enchants, now);
      logEvent(db, actor, "donated", r.instanceId, r.itemId, { enchants: r.enchants }, now);
    }
    const released = releaseVaultBotIfEmpty(db, actor.userId, seasonal);
    return { ok: true, donated: rows.length, seasonal, used: vaultCount(db, actor.userId, seasonal), slots: h.slots, released };
  }).immediate();
  if (out.ok) {
    emitTx();
    notifyPoolChanged();
  }
  return out;
}

/**
 * Set how many of the account's slots one half holds. Slots come in blocks
 * of VAULT_BLOCK and the two halves share users.vault_slots, so growing a
 * half needs unallocated slots — shrink the other half first. A half can't
 * shrink below what it holds (items plus wishes) or while a request into or
 * out of it is open; a half shrunk to nothing gives its bot back.
 */
export function allocateVaultSlots(db: Database.Database, actor: Actor, seasonal: boolean, slots: number): VaultResult<{ seasonal: boolean; slots: number; unallocated: number }> {
  if (!Number.isInteger(slots) || slots < 0 || slots % VAULT_BLOCK !== 0) {
    return { ok: false, status: 400, error: `Slots are allocated ${VAULT_BLOCK} at a time.` };
  }
  return db.transaction((): VaultResult<{ seasonal: boolean; slots: number; unallocated: number }> => {
    const a = vaultHalves(db, actor.userId);
    const mine = seasonal ? a.seasonal : a.nonseasonal;
    const other = seasonal ? a.nonseasonal : a.seasonal;
    if (slots === mine.slots) return { ok: true, seasonal, slots, unallocated: a.unallocated };
    if (slots > mine.slots) {
      const room = a.total - other.slots;
      if (slots > room) {
        return {
          ok: false,
          status: 409,
          error: other.slots > 0
            ? `You have ${a.total} slot${a.total === 1 ? "" : "s"} in all and ${other.slots} of them are in your ${poolName(!seasonal)} vault. Free some there first.`
            : `You have ${a.total} slot${a.total === 1 ? "" : "s"} in all.`,
        };
      }
    } else {
      const used = vaultCount(db, actor.userId, seasonal);
      const wishes = wishCount(db, actor.userId, seasonal);
      if (used + wishes > slots) {
        return {
          ok: false,
          status: 409,
          error: `Your ${poolName(seasonal)} vault holds ${used} item${used === 1 ? "" : "s"} and ${wishes} wish${wishes === 1 ? "" : "es"}; withdraw, donate or remove some before taking slots away.`,
        };
      }
      if (openVaultRequests(db, actor.userId, seasonal) > 0) {
        return { ok: false, status: 409, error: `Finish or cancel the open request on your ${poolName(seasonal)} vault before taking slots away.` };
      }
    }
    db.prepare("UPDATE vault_halves SET slots = ? WHERE user_id = ? AND seasonal = ?").run(slots, actor.userId, seasonal ? 1 : 0);
    if (slots === 0) releaseVaultBotIfEmpty(db, actor.userId, seasonal);
    logEvent(db, actor, "allocated", null, null, { seasonal, slots }, Date.now());
    return { ok: true, seasonal, slots, unallocated: vaultHalves(db, actor.userId).unallocated };
  }).immediate();
}

// --- the player's view -----------------------------------------------------------

export interface VaultItemView {
  instanceId: string;
  itemId: string;
  itemName: string;
  enchantments: { id: number; name: string | null }[];
  rarity: "common" | "uncommon" | "rare" | "legendary" | "divine";
  seasonal: boolean;
  /** Where the fleet's tracker sees it right now; "" when it isn't on any tracked bot. */
  botGuid: string;
  botIgn: string;
  server: string;
  online: boolean;
  /** Still on a pool bot, waiting for the fleet to move it to the vault bot. */
  inTransit: boolean;
  /** Named by an open withdraw of yours. */
  reserved: boolean;
  /** No tracked bot holds it any more (its bot was retired, or the item is gone). */
  lost: boolean;
  source: "claim" | "deposit";
  since: number;
}

export interface VaultHalfView {
  seasonal: boolean;
  slots: number;
  used: number;
  /** Wishes pending against this half; each holds a slot (lib/wishlist.ts). */
  wishes: number;
  bot: { guid: string; ign: string; server: string; online: boolean } | null;
}

export interface VaultView {
  /** The account's entitlement, shared by the halves in blocks of `block`. */
  total: number;
  block: number;
  unallocated: number;
  seasonal: VaultHalfView;
  nonseasonal: VaultHalfView;
  /** Both halves' items; each says which it belongs to. */
  items: VaultItemView[];
}

const RARITY_BY_COUNT: VaultItemView["rarity"][] = ["common", "uncommon", "rare", "legendary", "divine"];

export function vaultView(db: Database.Database, userId: number, pool: PyrelayPool | null): VaultView {
  const a = vaultHalves(db, userId);
  const rows = vaultItems(db, userId);
  const reserved = reservedInstanceIds(db);
  const meta = pool?.botMeta ?? {};
  // instance -> holding bot, from the live tracker.
  const where = new Map<string, { botGuid: string; enchantments: number[] }>();
  if (pool) {
    for (const [g, slots] of Object.entries(pool.instances ?? {})) {
      for (const info of Object.values(slots)) where.set(info.instanceId, { botGuid: g, enchantments: info.enchantments ?? [] });
    }
  }
  const items: VaultItemView[] = rows.map((r) => {
    const loc = where.get(r.instanceId);
    const botGuid = loc?.botGuid ?? r.botGuid ?? "";
    const m = meta[botGuid];
    const enchIds = loc?.enchantments ?? [];
    const enchantments = enchIds.map((id) => ({ id, name: enchantName(id) }));
    const count = loc ? enchantments.length : r.enchants;
    const home = (r.seasonal ? a.seasonal : a.nonseasonal).botGuid;
    return {
      instanceId: r.instanceId,
      itemId: r.itemId,
      itemName: ITEM_BY_ID.get(r.itemId)?.name ?? r.itemId,
      enchantments,
      rarity: RARITY_BY_COUNT[Math.min(count, RARITY_BY_COUNT.length - 1)],
      seasonal: r.seasonal,
      botGuid,
      botIgn: m?.ign ?? "",
      server: m?.server ?? "",
      online: !!m?.online,
      inTransit: !!pool && !!loc && home !== null && loc.botGuid !== home,
      reserved: reserved.has(r.instanceId),
      lost: !!pool && !loc,
      source: r.source,
      since: r.createdAt,
    };
  });
  const half = (h: VaultHalf): VaultHalfView => {
    const bm = h.botGuid ? meta[h.botGuid] : undefined;
    return {
      seasonal: h.seasonal,
      slots: h.slots,
      used: rows.filter((r) => r.seasonal === h.seasonal).length,
      wishes: wishCount(db, userId, h.seasonal),
      bot: h.botGuid ? { guid: h.botGuid, ign: bm?.ign ?? "", server: bm?.server ?? "", online: !!bm?.online } : null,
    };
  };
  return { total: a.total, block: VAULT_BLOCK, unallocated: a.unallocated, seasonal: half(a.seasonal), nonseasonal: half(a.nonseasonal), items };
}

// --- the fleet's view ---------------------------------------------------------------

export interface FleetVaultItem {
  instanceId: string;
  itemId: string;
  /** Where the site last recorded it (the fleet trusts its own tracker over this). */
  botGuid: string | null;
  /** Named by an open withdraw: leave it where it is. */
  reserved: boolean;
}
export interface FleetVault {
  userId: number;
  botGuid: string | null;
  seasonal: boolean;
  items: FleetVaultItem[];
}

/**
 * Every vault half with something in it, for the dispatcher: which bot is
 * the half's, and which physical items it owns, so the fleet can pack them
 * onto that bot, keep them out of the pool's own moves, and never offer them
 * to anyone else.
 */
export function listVaultsForFleet(db: Database.Database): FleetVault[] {
  const rows = db.prepare(
    `SELECT v.user_id, v.seasonal, v.instance_id, v.item_id, v.bot_guid, h.bot_guid AS vault_bot_guid
       FROM vault_items v LEFT JOIN vault_halves h ON h.user_id = v.user_id AND h.seasonal = v.seasonal
      ORDER BY v.user_id, v.seasonal DESC, v.rowid`,
  ).all() as { user_id: number; seasonal: number; instance_id: string; item_id: string; bot_guid: string | null; vault_bot_guid: string | null }[];
  if (!rows.length) return [];
  const reserved = reservedInstanceIds(db);
  const out = new Map<string, FleetVault>();
  for (const r of rows) {
    const key = `${r.user_id}:${r.seasonal}`;
    let v = out.get(key);
    if (!v) {
      v = { userId: r.user_id, botGuid: r.vault_bot_guid, seasonal: r.seasonal !== 0, items: [] };
      out.set(key, v);
    }
    v.items.push({ instanceId: r.instance_id, itemId: r.item_id, botGuid: r.bot_guid, reserved: reserved.has(r.instance_id) });
  }
  return [...out.values()];
}

/** The fleet moved these owned items onto `botGuid`. */
export function noteVaultMoved(db: Database.Database, instanceIds: string[], botGuid: string): number {
  const now = Date.now();
  return db.transaction(() => {
    const upd = db.prepare("UPDATE vault_items SET bot_guid = ? WHERE instance_id = ? AND bot_guid IS NOT ?");
    const ev = db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) SELECT user_id, '', 'moved', instance_id, item_id, ?, ? FROM vault_items WHERE instance_id = ?");
    let n = 0;
    for (const id of instanceIds) {
      if (upd.run(botGuid, id, botGuid).changes) {
        ev.run(JSON.stringify({ to: botGuid }), now, id);
        n++;
      }
    }
    return n;
  }).immediate();
}
