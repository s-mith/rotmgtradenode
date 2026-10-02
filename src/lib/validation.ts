import { MAX_TRADE_SLOTS, isDepositSize } from "./depositSizes";
import { ITEM_BY_ID } from "./catalog";
import { nodeTakes, takesFor } from "./itemPolicy";
import { SERVER_SET, DEPOSIT_ONLY_SERVERS } from "./servers";
import { isPotionStat, type PotionStat } from "./potionPlan";

type Err = { ok: false; error: string };
type Ok<T> = T & { ok: true };
type Result<T> = Ok<T> | Err;

function err(error: string): Err {
  return { ok: false, error };
}

export function checkIgn(v: unknown): Result<{ ign: string; ignLower: string }> {
  const ign = typeof v === "string" ? v.trim() : "";
  if (!ign || ign.length > 32) return err("Invalid IGN (1-32 chars)");
  if (!/^[A-Za-z]+$/.test(ign)) return err("IGN must be letters only");
  return { ok: true, ign, ignLower: ign.toLowerCase() };
}

function checkServer(v: unknown): Result<{ server: string }> {
  if (typeof v !== "string" || !SERVER_SET.has(v)) return err("Pick a valid server");
  return { ok: true, server: v };
}

export type DepositReq = {
  ign: string;
  ignLower: string;
  server: string;
  /** The one trade's size: the bot must have this many free slots — 8 (an empty bot) or 16 (an empty bot with a backpack). */
  slots: number;
  /** What the player said they are bringing, if they said. */
  items?: { itemId: string; qty: number }[];
  /** Into communism accounts rather than the pool. */
  communism: boolean;
};

/** A deposit is one trade: what it declares can fill at most one bot's trade slots. */
export const MAX_DECLARED_ITEMS = MAX_TRADE_SLOTS;

/**
 * Optional "what I'm bringing" on a deposit: [{itemId, qty}] over catalog ids.
 * A hint for routing, never a limit on what the trade accepts. Undefined when
 * absent; an error only when it is present and malformed.
 */
export function parseDeclaredItems(v: unknown, communism = false): Result<{ items?: { itemId: string; qty: number }[] }> {
  const takes = takesFor(communism);
  if (v === undefined || v === null) return { ok: true };
  if (!Array.isArray(v)) return err("items must be a list of {itemId, qty}");
  if (v.length > MAX_TRADE_SLOTS) return err(`items: at most ${MAX_TRADE_SLOTS} entries`);
  const merged = new Map<string, number>();
  let total = 0;
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return err("items must be a list of {itemId, qty}");
    const { itemId, qty } = raw as { itemId?: unknown; qty?: unknown };
    if (typeof itemId !== "string" || !ITEM_BY_ID.has(itemId)) return err(`Unknown item: ${String(itemId)}`);
    if (!takes(itemId)) return err(`${ITEM_BY_ID.get(itemId)!.name} is not taken ${communism ? "into communism" : "on this node"}`);
    const n = qty === undefined ? 1 : Number(qty);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DECLARED_ITEMS) return err(`items: qty for ${itemId} must be 1-${MAX_DECLARED_ITEMS}`);
    merged.set(itemId, (merged.get(itemId) ?? 0) + n);
    total += n;
    if (total > MAX_DECLARED_ITEMS) return err(`items: at most ${MAX_DECLARED_ITEMS} in total`);
  }
  if (!merged.size) return { ok: true };
  return { ok: true, items: [...merged].map(([itemId, qty]) => ({ itemId, qty })) };
}

export function parseDepositRequest(body: {
  ign?: unknown;
  server?: unknown;
  slots?: unknown;
  itemCount?: unknown;
  items?: unknown;
  communism?: unknown;
}): Result<DepositReq> {
  const i = checkIgn(body.ign);
  if (!i.ok) return i;
  const s = checkServer(body.server);
  if (!s.ok) return s;
  const declared = parseDeclaredItems(body.items, body.communism === true);
  if (!declared.ok) return declared;
  // The trade size: as many items as the player brings, 1 to one bot's whole
  // inventory. A deposit is one trade of that size, so a bot with that much
  // room meets them. `itemCount` is the old name for it; nothing at all
  // means the declared list's total, else 8.
  const declaredTotal = declared.items?.reduce((a, it) => a + it.qty, 0);
  let slots: number;
  if (body.slots !== undefined && body.slots !== null) {
    slots = Number(body.slots);
    if (!isDepositSize(slots)) return err(`slots must be 1-${MAX_TRADE_SLOTS}`);
  } else if (body.itemCount !== undefined && body.itemCount !== null) {
    const n = Number(body.itemCount);
    if (!Number.isInteger(n) || n < 1) return err("Item count must be a whole number of at least 1");
    slots = Math.min(n, MAX_TRADE_SLOTS);
  } else {
    slots = declaredTotal ? Math.min(declaredTotal, MAX_TRADE_SLOTS) : 8;
  }
  return { ok: true, ign: i.ign, ignLower: i.ignLower, server: s.server, slots, communism: body.communism === true, ...(declared.items ? { items: declared.items } : {}) };
}

export type BulkPotionReq = {
  stat: PotionStat;
  points: number;
};

// Bulk potion withdraws are sized in STAT POINTS: the fragmenter splits them
// across as many bots and trades as it takes, and fills only what the pool
// actually has free, so the pool's stock is the limit.

export type WithdrawReq = {
  ign: string;
  ignLower: string;
  server: string;
  // Which pool tab the player was on. A seasonal character can only trade a
  // seasonal bot, so this decides which half of the fleet may serve the
  // request — for every mode below, including bulk potions. Absent means
  // seasonal, matching the deposit path and the pre-split default.
  seasonal: boolean;
  // Set only in bulk potion mode. The concrete item list isn't known until the
  // route sees live pool stock, so parsing stops at (stat, points).
  potion: BulkPotionReq | null;
  // Exactly one of these is set. instanceIds is the per-instance flow (the
  // user clicked specific physical items in the pool grid); itemIds is the
  // legacy aggregate flow (item type only, any matching instance).
  instanceIds: string[] | null;
  itemIds: string[] | null;
  /** Out of communism accounts (per-instance only). */
  communism: boolean;
};

// A pool withdraw has no count limit of its own: picks must exist in the pool
// (the route checks each id), each bot's share is bounded by its character's
// trade slots, and the bot hands over in as many windows as the player's
// inventory has room for (chunking). The pool's stock is the limit.
/** A communism withdraw takes up to a character's eight slots in one meeting. */
export const MAX_PER_COMMUNISM_WITHDRAW = 8;

export function parseWithdrawRequest(body: {
  ign?: unknown;
  server?: unknown;
  seasonal?: unknown;
  itemIds?: unknown;
  instanceIds?: unknown;
  potionStat?: unknown;
  potionPoints?: unknown;
  communism?: unknown;
}): Result<WithdrawReq> {
  const i = checkIgn(body.ign);
  if (!i.ok) return i;
  const s = checkServer(body.server);
  if (!s.ok) return s;
  const seasonal = body.seasonal === undefined ? true : Boolean(body.seasonal);
  const communism = body.communism === true;
  // Deposit-only realms. Checked here rather than per-mode so it covers the
  // aggregate, per-instance AND bulk-potion flows in one place.
  if (DEPOSIT_ONLY_SERVERS.has(s.server)) {
    return err(
      `${s.server} is deposit-only — its login queue would make a withdraw slower. Pick another server.`,
    );
  }

  // Bulk potion mode: "give me N points of <stat>". Checked before the item
  // modes so a request carrying potionStat is never mistaken for an empty
  // itemIds list.
  if (body.potionStat !== undefined || body.potionPoints !== undefined) {
    if (communism) return err("Communism is withdrawn item by item");
    if (!isPotionStat(body.potionStat)) return err("Pick a stat to max");
    const points = Number(body.potionPoints);
    if (!Number.isInteger(points) || points < 1)
      return err("Stat points must be a whole number of at least 1");
    return {
      ok: true,
      ign: i.ign,
      ignLower: i.ignLower,
      server: s.server,
      seasonal,
      potion: { stat: body.potionStat, points },
      instanceIds: null,
      itemIds: null,
      communism: false,
    };
  }

  if (Array.isArray(body.instanceIds) && body.instanceIds.length > 0) {
    if (communism && body.instanceIds.length > MAX_PER_COMMUNISM_WITHDRAW)
      return err(`Max ${MAX_PER_COMMUNISM_WITHDRAW} items per communism withdraw`);
    if (new Set(body.instanceIds).size !== body.instanceIds.length) return err("The same item is picked twice");
    const instanceIds: string[] = [];
    for (const raw of body.instanceIds) {
      // Pyrelay mints UUID hex (32 chars) but we allow any sensible token
      // so a future format change doesn't immediately break us.
      if (typeof raw !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(raw))
        return err(`Invalid instance id: ${String(raw)}`);
      instanceIds.push(raw);
    }
    return {
      ok: true,
      ign: i.ign,
      ignLower: i.ignLower,
      server: s.server,
      seasonal,
      potion: null,
      instanceIds,
      itemIds: null,
      communism,
    };
  }

  if (communism) return err("Pick the items to take from communism");
  if (!Array.isArray(body.itemIds) || body.itemIds.length === 0)
    return err("Pick at least 1 item");
  const itemIds: string[] = [];
  for (const raw of body.itemIds) {
    if (typeof raw !== "string" || !ITEM_BY_ID.has(raw))
      return err(`Unknown item: ${String(raw)}`);
    itemIds.push(raw);
  }
  return {
    ok: true,
    ign: i.ign,
    ignLower: i.ignLower,
    server: s.server,
    seasonal,
    potion: null,
    instanceIds: null,
    itemIds,
    communism: false,
  };
}

export type FulfillReq = {
  requestId: number;
  items: { itemId: string; qty: number }[];
  nonce: string;
  timestamp: number;
  signature: string;
};

export function parseFulfillRequest(body: {
  requestId?: unknown;
  items?: unknown;
  nonce?: unknown;
  timestamp?: unknown;
  signature?: unknown;
}): Result<FulfillReq> {
  const requestId = Number(body.requestId);
  if (!Number.isInteger(requestId) || requestId < 1) return err("Invalid requestId");
  if (!Array.isArray(body.items) || body.items.length === 0)
    return err("items must be a non-empty array");
  if (body.items.length > 8) return err("items max length is 8");
  const items: { itemId: string; qty: number }[] = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object") return err("Bad item entry");
    const itemId = (raw as { itemId?: unknown }).itemId;
    const qty = Number((raw as { qty?: unknown }).qty);
    if (typeof itemId !== "string" || !ITEM_BY_ID.has(itemId))
      return err(`Unknown item: ${String(itemId)}`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999)
      return err("Item qty must be 1-999");
    items.push({ itemId, qty });
  }
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return err("Invalid nonce (16-64 url-safe chars)");
  const timestamp = Number(body.timestamp);
  if (!Number.isInteger(timestamp) || timestamp < 1) return err("Invalid timestamp");
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!/^[a-f0-9]{64}$/.test(signature)) return err("Invalid signature");
  return { ok: true, requestId, items, nonce, timestamp, signature };
}
