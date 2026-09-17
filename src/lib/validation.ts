import { DEPOSIT_SIZES, isDepositSize } from "./depositSizes";
import { ITEM_BY_ID } from "./catalog";
import { nodeTakes } from "./itemPolicy";
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
  /** Into the player's personal storage rather than the pool. */
  vault: boolean;
};

export const MAX_DECLARED_ITEMS = 64;

/**
 * Optional "what I'm bringing" on a deposit: [{itemId, qty}] over catalog ids.
 * A hint for routing, never a limit on what the trade accepts. Undefined when
 * absent; an error only when it is present and malformed.
 */
export function parseDeclaredItems(v: unknown): Result<{ items?: { itemId: string; qty: number }[] }> {
  if (v === undefined || v === null) return { ok: true };
  if (!Array.isArray(v)) return err("items must be a list of {itemId, qty}");
  if (v.length > 16) return err("items: at most 16 entries");
  const merged = new Map<string, number>();
  let total = 0;
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return err("items must be a list of {itemId, qty}");
    const { itemId, qty } = raw as { itemId?: unknown; qty?: unknown };
    if (typeof itemId !== "string" || !ITEM_BY_ID.has(itemId)) return err(`Unknown item: ${String(itemId)}`);
    if (!nodeTakes(itemId)) return err(`${ITEM_BY_ID.get(itemId)!.name} is not taken on this node`);
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
  vault?: unknown;
}): Result<DepositReq> {
  const i = checkIgn(body.ign);
  if (!i.ok) return i;
  const s = checkServer(body.server);
  if (!s.ok) return s;
  const declared = parseDeclaredItems(body.items);
  if (!declared.ok) return declared;
  // The trade size is one of the two shapes a bot comes in: 8 free slots
  // (an empty bot) or 16 (an empty bot with a backpack). A deposit is one
  // trade of that size, so this is what the player can hand over, not an
  // estimate. `itemCount` is the old declared upper bound; a caller still
  // sending it gets the smallest shape that fits it. Nothing at all: 8, or
  // 16 when the declared list needs it.
  const declaredTotal = declared.items?.reduce((a, it) => a + it.qty, 0);
  let slots: number;
  if (body.slots !== undefined && body.slots !== null) {
    slots = Number(body.slots);
    if (!isDepositSize(slots)) return err(`slots must be ${DEPOSIT_SIZES.join(" or ")}`);
  } else if (body.itemCount !== undefined && body.itemCount !== null) {
    const n = Number(body.itemCount);
    if (!Number.isInteger(n) || n < 1 || n > 64) return err("Item count must be 1-64");
    slots = n <= 8 ? 8 : n <= 16 ? 16 : 24;
  } else {
    const t = declaredTotal ?? 0;
    slots = t > 16 ? 24 : t > 8 ? 16 : 8;
  }
  return { ok: true, ign: i.ign, ignLower: i.ignLower, server: s.server, slots, vault: body.vault === true, ...(declared.items ? { items: declared.items } : {}) };
}

export type BulkPotionReq = {
  stat: PotionStat;
  points: number;
};

// Bulk potion withdraws are sized in STAT POINTS, and a max-out can easily be
// 20-50 points, so they aren't subject to MAX_PER_WITHDRAW — the fragmenter
// splits them across as many bots and trades as it takes. This ceiling is only
// a sanity bound on a hand-typed number.
const MAX_POTION_POINTS = 250;

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
  /** Out of the player's personal storage (per-instance only). */
  vault: boolean;
};

const MAX_PER_WITHDRAW = 4;

export function parseWithdrawRequest(body: {
  ign?: unknown;
  server?: unknown;
  seasonal?: unknown;
  itemIds?: unknown;
  instanceIds?: unknown;
  potionStat?: unknown;
  potionPoints?: unknown;
  vault?: unknown;
}): Result<WithdrawReq> {
  const i = checkIgn(body.ign);
  if (!i.ok) return i;
  const s = checkServer(body.server);
  if (!s.ok) return s;
  const seasonal = body.seasonal === undefined ? true : Boolean(body.seasonal);
  const vault = body.vault === true;
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
    if (vault) return err("Personal storage is withdrawn item by item");
    if (!isPotionStat(body.potionStat)) return err("Pick a stat to max");
    const points = Number(body.potionPoints);
    if (!Number.isInteger(points) || points < 1)
      return err("Stat points must be a whole number of at least 1");
    if (points > MAX_POTION_POINTS)
      return err(`Max ${MAX_POTION_POINTS} stat points per request`);
    return {
      ok: true,
      ign: i.ign,
      ignLower: i.ignLower,
      server: s.server,
      seasonal,
      potion: { stat: body.potionStat, points },
      instanceIds: null,
      itemIds: null,
      vault: false,
    };
  }

  if (Array.isArray(body.instanceIds) && body.instanceIds.length > 0) {
    if (body.instanceIds.length > MAX_PER_WITHDRAW)
      return err(`Max ${MAX_PER_WITHDRAW} items per withdraw`);
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
      vault,
    };
  }

  if (vault) return err("Pick the items to withdraw from your vault");
  if (!Array.isArray(body.itemIds) || body.itemIds.length === 0)
    return err("Pick at least 1 item");
  if (body.itemIds.length > MAX_PER_WITHDRAW) return err(`Max ${MAX_PER_WITHDRAW} items per withdraw`);
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
    vault: false,
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
