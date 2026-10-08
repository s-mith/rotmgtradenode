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
import { acrossRoomFor, committedDepositSlots, communismRoomFor, filterBotsByPool, largestFreeSlots, totalPoolSlots } from "./capacity";
import { MAX_TRADE_SLOTS } from "./depositSizes";
import { pyrelay } from "./devauth";
import { openRequestsFor } from "./cancelCode";
import { sweepStaleRequests } from "./timeouts";
import { advancedForPool } from "./advanced";
import { notifyPendingChange } from "./queue";

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
    /** How many items, 1-24. Into the pool it is one trade's size (only a bot with that much room takes it, unless
     *  advanced management continues it); into communism it continues over as many trades as it needs. */
    slots: number;
    /** 1 = seasonal pool, 0 = non-seasonal. Only a matching-pool bot can claim. */
    seasonal: 0 | 1;
    /** What the player says they are bringing; routes the deposit to the
     *  bot already gathering those potions. Optional, never enforced. */
    items?: { itemId: string; qty: number }[];
    /** Into communism: only a communism account of this half may claim it,
     *  and the room is communism accounts' free slots. */
    communism?: boolean;
  },
): Promise<CreateDepositResult> {
  const { ign, ignLower, server, seasonal } = args;
  const itemsJson = args.items?.length ? JSON.stringify(args.items) : null;
  const communism = !!args.communism;
  const slots = args.slots;
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

  // Capacity is per pool: only bots serving this deposit's pool can
  // ever claim it, so a full seasonal vault must not block a non-seasonal
  // deposit (and vice versa). The universe is tracker ∪ botMeta — the
  // tracker only lists bots that have connected once, but pyrelay
  // registers every pool account in botMeta up front, and a fresh pool half
  // (first non-seasonal batch) exists only there. Meta-only bots hold
  // nothing and count the conservative 8 slots.
  // Communism accounts are communism's room, not the pool's, and the other
  // way round.
  const trackerGuids = filterBotsByPool(
    [...new Set([...Object.keys(tracker), ...Object.keys(botMeta ?? {})])].filter((g) => !!botMeta?.[g]?.communism === communism),
    botMeta,
    seasonal ? "seasonal" : "nonseasonal",
  );
  // Pool accounts playing the other side that have characters on this one
  // serve it too, logging in as one of them: their slots there are room.
  const across = communism ? { bots: 0, slots: 0, used: 0 } : acrossRoomFor(poolResp.ok ? poolResp.data.acrossRoom : undefined, seasonal ? "seasonal" : "nonseasonal", (g) => !!botMeta?.[g]?.suspended);
  // Communism takes a deposit over as many trades as it needs, on whichever
  // character of its accounts has room (lib/queue.ts continues it), so its
  // room is every character of its side, not the one each account plays.
  const communismSide = communism && poolResp.ok ? communismRoomFor(poolResp.data, seasonal ? "seasonal" : "nonseasonal") : null;
  const totalSlots = communismSide ? communismSide.slots : totalPoolSlots(trackerGuids, capacities, trackerGuids.length) + across.slots;
  let usedSlots = communismSide ? communismSide.used : across.used;
  if (!communismSide) {
    for (const guid of trackerGuids) {
      for (const qty of Object.values(tracker[guid] ?? {})) usedSlots += qty;
    }
  }
  const freeSlotsGlobal = Math.max(0, totalSlots - usedSlots);
  // The biggest single trade a bot could take right now. The embedded fleet
  // says so itself, counting only bots it would send (not suspended, held,
  // parked or locked out); a plain snapshot falls back to capacity minus load.
  // Under advanced management (docs/relay/ADVANCED.md) it is the biggest
  // deposit the side takes now: one empty character after another, so it
  // may be more than one bot holds. Communism needs no one trade's room: it continues.
  const room = poolResp.ok && !communism ? poolResp.data.room : undefined;
  const advanced = advancedForPool(communism);
  const largestFree = room ? room[seasonal ? "seasonal" : "nonseasonal"].largestFree : largestFreeSlots(trackerGuids, tracker, capacities);
  // `canMake` was the automatic backpack fitting (removed 2026-09-22); the pool payload still carries it, always false.
  const canMake = !!room && slots > 8 && room[seasonal ? "seasonal" : "nonseasonal"].canMake;
  if (totalSlots === 0) {
    return {
      ok: false,
      status: 503,
      error: communism ? "No communism account for this pool on this node." : "No bots online for this pool yet — try again in a minute.",
    };
  }

  const now = Date.now();
  const groupId = crypto.randomUUID();
  const tx = db.transaction(() => {
    // One deposit per IGN at a time. Under advanced management one deposit
    // already continues across empty bots by itself (lib/queue.ts
    // fulfillDeposit); a second concurrent deposit for the same IGN just
    // confuses the dispatcher (which row claims the next bot?) and the user
    // (multiple "/trade <bot>" hints in the UI). Also still serves as the
    // griefer gate.
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
    const committedSlots = committedDepositSlots(db, { seasonal: seasonal ? 1 : 0, communism });
    const availableSlots = Math.max(0, freeSlotsGlobal - committedSlots);
    const where = communism ? "communism" : "this pool";
    if (availableSlots < slots) {
      return {
        kind: "err" as const,
        status: 409,
        error: availableSlots < 1 ? `${communism ? "Communism is" : "Vault is"} full — wait for a withdrawal to free up space.` : `Only ${availableSlots} slot${availableSlots === 1 ? "" : "s"} of room left in ${where} right now — not enough for ${communism ? `${slots} items` : `a ${slots}-slot trade`}.`,
      };
    }
    if (!communism && largestFree < slots && !canMake) {
      return {
        kind: "err" as const,
        status: 409,
        error:
          largestFree < 1
            ? "No bot has room right now. Try again later."
            : advanced
              ? `This pool can take ${largestFree} item${largestFree === 1 ? "" : "s"} right now, not ${slots}. Bring fewer, or try again later.`
              : `No bot has ${slots} free slots right now; the most one trade can take is ${largestFree}. Bring fewer, or try again later.`,
      };
    }
    const result = db
      .prepare(
        `INSERT INTO deposit_requests
           (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, items_json, communism, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(ign, ignLower, server, slots, slots, groupId, seasonal, itemsJson, communism ? 1 : 0, now, now);
    return { kind: "ok" as const, requestId: Number(result.lastInsertRowid) };
  }).immediate();

  if (tx.kind === "err") {
    return { ok: false, status: tx.status, error: tx.error };
  }
  notifyPendingChange();
  return { ok: true, requestId: tx.requestId, groupId };
}
