// Taking from communism as a library call: what the /api/withdraw route
// does for a per-instance pick, for callers that have no browser session —
// the hub request runner (src/node/requests.ts) queues these for hub users.
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { WantLineWire } from "../shared/hubWire";
import type { PyrelayPool } from "./devauth";
import { advancedForPool } from "./advanced";
import { ITEM_BY_ID } from "./catalog";
import { isCommunismBot } from "./communismPool";
import { maxOpenWithdraws } from "./cancelCode";
import { communismTakes } from "./itemPolicy";
import { notifyPendingChange } from "./queue";
import { reservedInstanceIds } from "./reservations";
import { MAX_PER_COMMUNISM_WITHDRAW } from "./validation";

export type CommunismWithdrawResult = { ok: true; groupId: string; requestIds: number[]; fetched: number } | { ok: false; status: number; error: string };

/** "N of this item" (docs/relay/ADVANCED.md): plain copies of `itemId`, whichever ones the node picks. */
export interface CommunismWant {
  itemId: string;
  qty: number;
}

/** One picked item and where it sits: on the played character, in a container (`stored`), or on another character; `worn`: equipped or in a quickslot. */
type Row = { instanceId: string; botGuid: string; itemId: string; enchants: number; stored: boolean; charId: number | null; charCapacity: number | null; worn?: boolean };
type Refusal = { ok: false; status: number; error: string };

/**
 * Queue a withdraw from communism accounts, to be handed to `ign` on
 * `server`: the picked `instanceIds`, or (`want`, advanced management for
 * communism only) as many plain copies of an item as asked, the node
 * choosing them. Rows are pinned to the communism account holding each item
 * now; an item in that account's storage is fetched by the fleet first.
 */
export function createCommunismWithdraw(db: Database.Database, pool: PyrelayPool, req: { ign: string; server: string; seasonal: boolean; instanceIds?: string[]; want?: CommunismWant[]; exclude?: string[] }): CommunismWithdrawResult {
  const out = req.want ? withdrawByCount(db, pool, { ...req, want: req.want }) : withdrawPicked(db, pool, { ...req, instanceIds: req.instanceIds ?? [] });
  if (out.ok) notifyPendingChange();
  return out;
}

function withdrawPicked(db: Database.Database, pool: PyrelayPool, req: { ign: string; server: string; seasonal: boolean; instanceIds: string[] }): CommunismWithdrawResult {
  const ids = [...new Set(req.instanceIds)];
  if (!ids.length) return { ok: false, status: 400, error: "Pick at least one item." };
  if (ids.length > MAX_PER_COMMUNISM_WITHDRAW) return { ok: false, status: 400, error: `At most ${MAX_PER_COMMUNISM_WITHDRAW} items in one communism withdraw.` };
  const wanted = new Set(ids);
  const rows = communismRows(pool, req.seasonal, (r) => wanted.has(r.instanceId));
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.instanceId));
    return { ok: false, status: 409, error: `Item no longer in communism: ${ids.find((id) => !found.has(id))}` };
  }
  const plan = planTrades(pool, rows, req.server, advancedForPool(true));
  if (!plan.ok) return plan;
  return db.transaction((): CommunismWithdrawResult => {
    const busy = openWithdrawsRefusal(db, req.ign);
    if (busy) return busy;
    const reserved = reservedInstanceIds(db);
    if (ids.some((id) => reserved.has(id))) return { ok: false, status: 409, error: "One of those items is already in an open withdraw or hand-over." };
    return insertTrades(db, req, plan.trades);
  }).immediate();
}

/** `exclude`: copies something outside this node holds (GuestRequestWire.held: the hub's open requests by ref), left alone like reserved ones. */
function withdrawByCount(db: Database.Database, pool: PyrelayPool, req: { ign: string; server: string; seasonal: boolean; want: CommunismWant[]; exclude?: string[] }): CommunismWithdrawResult {
  if (!advancedForPool(true)) return { ok: false, status: 409, error: "This node's communism is withdrawn item by item." };
  const want = mergeWant(req.want);
  if (typeof want === "string") return { ok: false, status: 400, error: want };
  // Plain copies only: one is as good as another, so the node may choose.
  const rows = communismRows(pool, req.seasonal, (r) => r.enchants === 0 && want.some((w) => w.itemId === r.itemId) && communismTakes(r.itemId));
  return db.transaction((): CommunismWithdrawResult => {
    const busy = openWithdrawsRefusal(db, req.ign);
    if (busy) return busy;
    // Picked under the lock: two requests at once never get the same copies.
    const picked = pickCopies(pool, rows, want, new Set([...reservedInstanceIds(db), ...(req.exclude ?? [])]), req.server);
    if ("short" in picked) {
      const name = ITEM_BY_ID.get(picked.short.itemId)?.name ?? picked.short.itemId;
      return { ok: false, status: 409, error: picked.short.have ? `Only ${picked.short.have} ${name} left in ${req.seasonal ? "seasonal" : "non-seasonal"} communism right now.` : `No ${name} left in ${req.seasonal ? "seasonal" : "non-seasonal"} communism right now.` };
    }
    const plan = planTrades(pool, picked.rows, req.server, true);
    if (!plan.ok) return plan;
    return insertTrades(db, req, plan.trades);
  }).immediate();
}

/** Every item on the side's communism accounts (suspended ones aside) that `keep` accepts, wherever on the account it sits. */
function communismRows(pool: PyrelayPool, seasonal: boolean, keep: (r: Row) => boolean): Row[] {
  const meta = pool.botMeta ?? {};
  const rows: Row[] = [];
  for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
    const m = meta[botGuid];
    if (!isCommunismBot(m) || m?.suspended || (m?.seasonal !== false) !== seasonal) continue;
    for (const info of Object.values(slots)) {
      const r: Row = { instanceId: info.instanceId, botGuid, itemId: info.itemId, enchants: (info.enchantments ?? []).length, stored: false, charId: null, charCapacity: null };
      if (keep(r)) rows.push(r);
    }
  }
  for (const [botGuid, stored] of Object.entries(pool.stored ?? {})) {
    const m = meta[botGuid];
    if (!isCommunismBot(m) || m?.suspended) continue;
    for (const s of stored) {
      if (!(seasonal ? s.pools.seasonal : s.pools.nonseasonal)) continue;
      const r: Row = { instanceId: s.instanceId, botGuid, itemId: s.itemId, enchants: (s.enchantments ?? []).length, stored: s.where.kind !== "char", charId: s.where.kind === "char" ? s.where.charId : null, charCapacity: s.where.kind === "char" ? s.where.capacity ?? 8 : null, ...(s.where.kind === "worn" || s.where.kind === "quickslot" ? { worn: true } : {}) };
      if (keep(r)) rows.push(r);
    }
  }
  return rows;
}

/**
 * Which copies a count takes: as few accounts as possible (the account
 * holding the most of an item first, one already chosen for another line
 * before any other), and on each account the played character's copies,
 * then its containers', then its other characters' — the order one session
 * reaches them in. Copies something else has spoken for are not taken, nor
 * copies on the character of an account playing on another server right
 * now (it is busy there). Worn and quickslot items stay where they are.
 */
function pickCopies(pool: PyrelayPool, rows: Row[], want: CommunismWant[], reserved: Set<string>, server: string): { rows: Row[] } | { short: { itemId: string; have: number } } {
  const meta = pool.botMeta ?? {};
  const busyElsewhere = (g: string) => !!meta[g]?.online && (meta[g]?.server ?? "") !== server;
  const where = (r: Row) => (!r.stored && r.charId === null ? 0 : r.charId === null ? 1 : 2);
  const usable = rows.filter((r) => !r.worn && !reserved.has(r.instanceId) && !(where(r) === 0 && busyElsewhere(r.botGuid)));
  const taken: Row[] = [];
  const chosen = new Set<string>();
  for (const w of want) {
    const byBot = new Map<string, Row[]>();
    for (const r of usable) if (r.itemId === w.itemId) byBot.set(r.botGuid, [...(byBot.get(r.botGuid) ?? []), r]);
    const have = [...byBot.values()].reduce((n, l) => n + l.length, 0);
    if (have < w.qty) return { short: { itemId: w.itemId, have } };
    const bots = [...byBot.entries()].sort(([ga, a], [gb, b]) =>
      Number(chosen.has(gb)) - Number(chosen.has(ga)) || b.length - a.length || b.filter((r) => where(r) === 0).length - a.filter((r) => where(r) === 0).length || (ga < gb ? -1 : 1));
    let left = w.qty;
    for (const [g, list] of bots) {
      if (left <= 0) break;
      // The played character's copies, then storage's (one fetch), then other characters' — and of those the
      // fewest trades: the smallest stack that covers what is left, else the biggest stacks first.
      const ordered = [...list].sort((a, b) => where(a) - where(b) || (a.instanceId < b.instanceId ? -1 : 1));
      const near = ordered.filter((r) => where(r) < 2);
      const take = near.slice(0, left);
      left -= take.length;
      const stacks = new Map<number, Row[]>();
      for (const r of ordered) if (where(r) === 2) stacks.set(r.charId!, [...(stacks.get(r.charId!) ?? []), r]);
      while (left > 0 && stacks.size) {
        const sizes = [...stacks.entries()];
        const covers = sizes.filter(([, l]) => l.length >= left).sort(([ca, a], [cb, b]) => a.length - b.length || ca - cb)[0];
        const [charId, stack] = covers ?? sizes.sort(([ca, a], [cb, b]) => b.length - a.length || ca - cb)[0];
        stacks.delete(charId);
        const part = stack.slice(0, left);
        take.push(...part);
        left -= part.length;
      }
      taken.push(...take);
      chosen.add(g);
    }
  }
  return { rows: taken };
}

/**
 * A trade per character: picks on several characters of one account are
 * handed over one after another, the account logging in as each in turn
 * (the played character's first, with anything fetched from containers onto
 * it). A character's trade is bounded by its slots: more picks than that is
 * refused, or with `split` (advanced management) handed over in as many
 * trades as it takes, back to back, the played character's own items first.
 */
function planTrades(pool: PyrelayPool, rows: Row[], server: string, split: boolean): { ok: true; trades: Row[][] } | Refusal {
  const meta = pool.botMeta ?? {};
  const byTrade = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.botGuid}|${r.charId != null ? `c${r.charId}` : "played"}`;
    byTrade.set(key, [...(byTrade.get(key) ?? []), r]);
  }
  for (const list of byTrade.values()) {
    const botGuid = list[0].botGuid;
    const m = meta[botGuid];
    const slots = tradeSlots(pool, list[0]);
    if (list.length > slots && !split) return { ok: false, status: 409, error: `${m?.ign || "That account"} can hand over at most ${slots} items in one trade.` };
    if (m?.online && list.some((r) => !r.stored && r.charId == null) && (m.server ?? "") !== server) return { ok: false, status: 409, error: `${m.ign} is busy on ${m.server} right now; pick that server or try again later.` };
  }
  const keys = [...byTrade.keys()].sort((a, b) => {
    const [ga, ca] = a.split("|"), [gb, cb] = b.split("|");
    return ga.localeCompare(gb) || Number(cb === "played") - Number(ca === "played") || ca.localeCompare(cb, undefined, { numeric: true });
  });
  const trades: Row[][] = [];
  for (const key of keys) {
    const list = [...byTrade.get(key)!].sort((a, b) => Number(a.stored) - Number(b.stored));
    const slots = tradeSlots(pool, list[0]);
    for (let i = 0; i < list.length; i += slots) trades.push(list.slice(i, i + slots));
  }
  return { ok: true, trades };
}

/** The slots of the character that plays a trade: another character's own, else the played character's. */
function tradeSlots(pool: PyrelayPool, r: Row): number {
  if (r.charId != null) return r.charCapacity ?? 8;
  const cap = pool.capacities?.[r.botGuid];
  return Number.isInteger(cap) && cap! > 0 ? cap! : 8;
}

function openWithdrawsRefusal(db: Database.Database, ign: string): Refusal | null {
  const openCount = (db.prepare("SELECT COUNT(DISTINCT group_id) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL").get(ign.toLowerCase()) as { n: number }).n;
  return openCount >= maxOpenWithdraws() ? { ok: false, status: 429, error: "Too many open withdraws for this IGN — finish one first." } : null;
}

/** One row per trade, in trade order, all in one group: the player's trades come one after another. */
function insertTrades(db: Database.Database, req: { ign: string; server: string; seasonal: boolean }, trades: Row[][]): CommunismWithdrawResult {
  const groupId = crypto.randomUUID();
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, communism, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1, ?, ?)`);
  const requestIds: number[] = [];
  let fetched = 0;
  for (const list of trades) {
    const botGuid = list[0].botGuid;
    const counts = new Map<string, { itemId: string; qty: number; enchants: number }>();
    for (const r of list) {
      const key = `${r.itemId}:${r.enchants}`;
      const cur = counts.get(key);
      if (cur) cur.qty += 1;
      else counts.set(key, { itemId: r.itemId, qty: 1, enchants: r.enchants });
    }
    fetched += list.filter((r) => r.stored).length;
    const itemsJson = JSON.stringify([...counts.values()].sort((a, b) => a.itemId.localeCompare(b.itemId) || a.enchants - b.enchants));
    const res = ins.run(req.ign, req.ign.toLowerCase(), req.server, itemsJson, groupId, botGuid, JSON.stringify(list.map((r) => r.instanceId).sort()), req.seasonal ? 1 : 0, now, now);
    requestIds.push(Number(res.lastInsertRowid));
  }
  return { ok: true, groupId, requestIds, fetched };
}

/** The same item asked for on several lines counts once; every line names a catalog item and a whole number, and the whole is one withdraw's worth. */
function mergeWant(want: CommunismWant[]): CommunismWant[] | string {
  const out = new Map<string, number>();
  for (const w of want) {
    if (!w || typeof w.itemId !== "string" || !ITEM_BY_ID.has(w.itemId)) return "Unknown item.";
    if (!Number.isInteger(w.qty) || w.qty < 1) return "Ask for at least one of an item.";
    out.set(w.itemId, (out.get(w.itemId) ?? 0) + w.qty);
  }
  const total = [...out.values()].reduce((n, q) => n + q, 0);
  if (!total) return "Ask for at least one item.";
  if (total > MAX_PER_COMMUNISM_WITHDRAW) return `At most ${MAX_PER_COMMUNISM_WITHDRAW} items in one communism withdraw.`;
  return [...out].map(([itemId, qty]) => ({ itemId, qty }));
}

/** A hub request's "N of this item" lines (GuestRequestWire.want) as a count to pick, or why not: plain copies only. */
export function countWant(lines: WantLineWire[]): CommunismWant[] | string {
  if (!Array.isArray(lines) || !lines.length) return "Ask for at least one item.";
  for (const l of lines) if (l && l.slotsExact !== null && l.slotsExact !== undefined && l.slotsExact !== 0) return "Only plain copies (no enchantments) are withdrawn by count.";
  return mergeWant(lines.map((l) => ({ itemId: l?.itemId, qty: l?.qty })));
}

/** Names for a picked set, for messages. */
export function describeItems(itemIds: string[]): string {
  const counts = new Map<string, number>();
  for (const id of itemIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, n]) => `${n > 1 ? `${n}× ` : ""}${ITEM_BY_ID.get(id)?.name ?? id}`).join(", ");
}
