// Creating a deposit request, independent of who asked for it.
//
// Two callers now: /api/deposit (the website form, IGN from the session
// cookie) and /api/ext/deposit (third-party automation, IGN from the body
// behind an API key). Everything after "which IGN is this for?" is identical —
// the same open-request gate, the same pool capacity accounting, the same
// insert — so it lives here rather than being copied. A divergence between
// the two would mean one path could book a slot the other believes is taken.
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { filterBotsByPool, largestFreeSlots, totalPoolSlots } from "./capacity";
import { MAX_TRADE_SLOTS } from "./depositSizes";
import { pyrelay } from "./devauth";
import { openRequestsFor } from "./cancelCode";
import { sweepStaleRequests } from "./timeouts";
import { ensureVaultBot, poolName, sharedVaultBotCandidates, sharedVaultBots, vaultBotCandidates, vaultBotGuids, vaultCount, vaultHalf } from "./vault";

export type CreateDepositOk = {
  ok: true;
  requestId: number;
  groupId: string;
};

export type CreateDepositErr = {
  ok: false;
  status: number;
  error: string;
  /** True when the refusal was "you already have one open" — the caller can
   *  offer a one-click cancel instead of just showing the message. */
  hasOpen?: boolean;
};

export type CreateDepositResult = CreateDepositOk | CreateDepositErr;

/**
 * Queue a deposit for `ign`, or explain why it can't be queued.
 *
 * Async because the pool snapshot comes from pyrelay over HTTP; the free-slot
 * check and the insert still happen together inside one immediate transaction
 * (see the comments inline — two concurrent deposits must not both book the
 * last slot).
 */
export async function createDepositRequest(
  db: Database.Database,
  args: {
    ign: string;
    ignLower: string;
    server: string;
    /** The one trade's size, 1-16: only a bot with this many free slots takes it (the site offers 8 or 16). */
    slots: number;
    /** 1 = seasonal pool, 0 = non-seasonal. Only a matching-pool bot can claim. */
    seasonal: 0 | 1;
    /** What the player says they are bringing; routes the deposit to the
     *  bot already gathering those potions. Optional, never enforced. */
    items?: { itemId: string; qty: number }[];
    /** Into this account's personal storage: only its vault bot may claim,
     *  the cap is the slots it has left, and nothing hits the ledger. */
    vaultUserId?: number;
  },
): Promise<CreateDepositResult> {
  const { ign, ignLower, server, seasonal } = args;
  const itemsJson = args.items?.length ? JSON.stringify(args.items) : null;
  const vaultUserId = args.vaultUserId ?? null;
  let slots = args.slots;
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_TRADE_SLOTS) {
    return { ok: false, status: 400, error: `Trade size must be 1-${MAX_TRADE_SLOTS} slots.` };
  }

  sweepStaleRequests(db);

  // One deposit per IGN at a time (enforced for real inside the transaction
  // below). Detected up front too so the UI can offer a one-click cancel of the
  // wedged request — the player is logged in, so cancelling is just POST
  // /api/cancel on their own session (no whispered code needed anymore).
  if (openRequestsFor(db, ignLower).deposits >= 1) {
    return {
      ok: false,
      status: 409,
      error: "You already have a deposit in progress — finish or cancel it first.",
      hasOpen: true,
    };
  }

  // Pool-level capacity gate. A deposit is ONE trade of `slots` items, so a
  // single bot has to have that much room: the gate is "does some bot in
  // this pool have `slots` free" (an empty backpack bot for 16), and then
  // "is the pool's free room not already promised to open deposits".
  //
  // The pyrelay snapshot is external — fetched outside the transaction.
  // The free-slot check + insert MUST be inside one immediate tx, or two
  // concurrent deposits both see "1 free slot" and both insert against a
  // vault that's actually one item from full.
  const poolResp = await pyrelay.pool();
  const tracker = poolResp.ok ? poolResp.data.bots : {};
  const capacities = poolResp.ok ? poolResp.data.capacities : undefined;
  const botMeta = poolResp.ok ? poolResp.data.botMeta : undefined;

  // Personal storage has its own gate: the account's slots in this pool
  // half, not the pool's. The row is capped at what is left, and the half
  // gets its bot now so the fleet knows who to send.
  let botCandidates: string[] = [];
  if (vaultUserId !== null) {
    const s = vaultHalf(db, vaultUserId, seasonal === 1);
    if (s.slots < 1) {
      return { ok: false, status: 409, error: `You have no vault slots allocated to the ${poolName(s.seasonal)} pool. Allocate some from My Vault first.` };
    }
    const left = s.slots - vaultCount(db, vaultUserId, s.seasonal);
    if (left < 1) {
      return { ok: false, status: 409, error: `Your ${poolName(s.seasonal)} vault is full (${s.slots} of ${s.slots} slots). Withdraw or donate something first.` };
    }
    // The vault bot is the only bot that can come, so the trade is as big
    // as the room left, whatever size was asked for.
    slots = Math.min(slots, left);
    if (!s.botGuid) {
      if (!poolResp.ok) return { ok: false, status: 503, error: "Bot service unavailable — try again in a minute." };
      botCandidates = sharedVaultBots() ? sharedVaultBotCandidates(db, poolResp.data, s.seasonal, vaultUserId) : vaultBotCandidates(db, poolResp.data, s.seasonal, vaultUserId);
      if (!botCandidates.length) return { ok: false, status: 503, error: "No free bot for your vault right now — try again in a minute." };
    }
  }
  // Capacity is per pool: only bots serving this deposit's pool can
  // ever claim it, so a full seasonal vault must not block a non-seasonal
  // deposit (and vice versa). The universe is tracker ∪ botMeta — the
  // tracker only lists bots that have connected once, but pyrelay
  // registers every pool account in botMeta up front, and a fresh pool half
  // (first non-seasonal batch) exists only there. Meta-only bots hold
  // nothing and count the conservative 8 slots.
  const vaultBots = vaultBotGuids(db);
  const trackerGuids = filterBotsByPool(
    [...new Set([...Object.keys(tracker), ...Object.keys(botMeta ?? {})])].filter((g) => !vaultBots.has(g)),
    botMeta,
    seasonal ? "seasonal" : "nonseasonal",
  );
  const totalSlots = totalPoolSlots(trackerGuids, capacities, trackerGuids.length);
  let usedSlots = 0;
  for (const guid of trackerGuids) {
    for (const qty of Object.values(tracker[guid] ?? {})) usedSlots += qty;
  }
  const freeSlotsGlobal = Math.max(0, totalSlots - usedSlots);
  // The biggest single trade a bot could take right now. The embedded fleet
  // says so itself, counting only bots it would send (not suspended, held,
  // parked or locked out); a plain snapshot falls back to capacity minus load.
  const room = poolResp.ok ? poolResp.data.room : undefined;
  const largestFree = room ? room[seasonal ? "seasonal" : "nonseasonal"].largestFree : largestFreeSlots(trackerGuids, tracker, capacities);
  // No bot with 16 free, but the fleet can fit an empty one with a backpack
  // on request: the deposit is accepted and the fleet makes the bot.
  const canMake = !!room && slots > 8 && room[seasonal ? "seasonal" : "nonseasonal"].canMake;
  if (totalSlots === 0 && vaultUserId === null) {
    return {
      ok: false,
      status: 503,
      error: "No bots online for this pool yet — try again in a minute.",
    };
  }

  const now = Date.now();
  const groupId = crypto.randomUUID();
  const tx = db.transaction(() => {
    // One deposit per IGN at a time. Multi-bot continuation already lets a
    // single deposit chain across however many bots the player wants to fill;
    // a second concurrent deposit for the same IGN just confuses the
    // dispatcher (which row claims the next bot?) and the user (multiple
    // "/trade <bot>" hints in the UI). Also still serves as the griefer gate.
    //
    // Checked INSIDE the immediate transaction, alongside the insert it
    // guards. Outside it, two submits for the same IGN arriving together
    // both read openCount = 0 and both insert — the withdraw route already
    // does its equivalent check in-transaction for exactly this reason.
    // The pre-transaction check above is what players actually hit (and
    // what offers them the cancel button); this one only catches that race,
    // so it answers without the cancel offer.
    const openCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM deposit_requests WHERE ign_lower = ? AND status IN ('pending','claimed')",
        )
        .get(ignLower) as { n: number }
    ).n;
    if (openCount >= 1) {
      return {
        kind: "err" as const,
        status: 409,
        error: "You already have a deposit in progress — finish or cancel it first.",
      };
    }

    // Dynamic vault reservation:
    //   - Pending row (not currently mid-trade): reserve only what's already
    //     been deposited so far (item_count - remaining_count). The player
    //     might not deposit anything more; we don't lock slots speculatively.
    //   - Claimed row (mid-trade): reserve deposited-so-far PLUS the in-flight
    //     trade cap, because that trade can still deliver up to current_cap
    //     more items before the player accepts.
    // Replaces the old "reserve all 16 declared slots up front" behavior so a
    // big declared upper bound doesn't lock the whole vault for one player.
    //
    // "Deposited so far" is counted from the transactions ledger, not from
    // (item_count - remaining_count). Deposits are open-ended — they chain
    // across bots for as long as the player keeps filling each one — but
    // remaining_count floors at 0, so the derived figure silently capped at
    // item_count (16 by default) and a player depositing 40 items reserved
    // slots for 16. The ledger has one row per item actually received, so
    // summing it tracks the real occupancy however far the chain runs.
    const committedSlots = (
      db
        .prepare(
          `SELECT COALESCE(SUM(
             (SELECT COALESCE(SUM(t.qty), 0) FROM transactions t
               WHERE t.kind = 'deposit' AND t.request_id = dr.id)
             + CASE WHEN dr.status = 'claimed' THEN COALESCE(dr.current_cap, 0) ELSE 0 END
           ), 0) AS n
           FROM deposit_requests dr
           WHERE dr.status IN ('pending','claimed') AND dr.seasonal = ?`,
        )
        .get(seasonal) as { n: number }
    ).n;
    const availableSlots = Math.max(0, freeSlotsGlobal - committedSlots);
    if (vaultUserId === null && availableSlots < slots) {
      return {
        kind: "err" as const,
        status: 409,
        error: availableSlots < 1 ? "Vault is full — wait for a withdrawal to free up space." : `Only ${availableSlots} slot${availableSlots === 1 ? "" : "s"} of room left in this pool right now — not enough for a ${slots}-slot trade.`,
      };
    }
    if (vaultUserId === null && largestFree < slots && !canMake) {
      return {
        kind: "err" as const,
        status: 409,
        error: `No bot has ${slots} free slots right now${slots > 8 ? ", and none can be fitted with a backpack at the moment" : ""}${slots > 8 && largestFree >= 8 ? " — ask for an 8-slot trade instead" : ""}. Try again later.`,
      };
    }
    if (vaultUserId !== null && botCandidates.length) {
      if (!ensureVaultBot(db, vaultUserId, seasonal === 1, botCandidates, now)) {
        return { kind: "err" as const, status: 503, error: "No free bot for your vault right now — try again in a minute." };
      }
    }
    const result = db
      .prepare(
        `INSERT INTO deposit_requests
           (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, items_json, vault_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(ign, ignLower, server, slots, slots, groupId, seasonal, itemsJson, vaultUserId, now, now);
    return { kind: "ok" as const, requestId: Number(result.lastInsertRowid) };
  }).immediate();

  if (tx.kind === "err") {
    return { ok: false, status: tx.status, error: tx.error };
  }
  return { ok: true, requestId: tx.requestId, groupId };
}
