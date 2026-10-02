import { json } from "@/server/http";
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { parseWithdrawRequest, type WithdrawReq } from "@/lib/validation";
import { ITEM_BY_ID } from "@/lib/catalog";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { checkWithdrawAllowance } from "@/lib/playerLimits";
import { isPoolBot } from "@/lib/capacity";
import { sweepStaleRequests } from "@/lib/timeouts";
import { fragmentWithdraw, type ItemReq } from "@/lib/fragmentWithdraw";
import {
  planPotionWithdraw,
  POTION_IDS,
  STAT_LABELS,
  type PotionWithdrawPlan,
} from "@/lib/potionPlan";
import { advancedForPool } from "@/lib/advanced";
import { notifyPendingChange } from "@/lib/queue";
import { pyrelay, swaps, type PyrelayPool } from "@/lib/devauth";
import { whereLabel } from "@/lib/poolWire";
import { maxOpenWithdraws, openRequestsFor } from "@/lib/cancelCode";
import { sessionFromRequest } from "@/lib/session";
import { blockMessage, withdrawBlock } from "@/lib/serverControls";
import { picksOverCommitted, reservedInstanceIds } from "@/lib/reservations";
import { isCommunismBot } from "@/lib/communismPool";


/**
 * What an account keeps in storage, as stock for one pool half: the items a
 * character of that side could carry out (docs/relay/STORAGE.md). The fleet
 * fetches them onto the character before the trade, so they count like the
 * character's own — within the character's slots, which `capacityOf` bounds.
 */
function storedFor(pool: PyrelayPool, botGuid: string, seasonal: boolean) {
  return (pool.stored?.[botGuid] ?? []).filter((s) => (seasonal ? s.pools.seasonal : s.pools.nonseasonal));
}
/** Trade slots on the bot's character: what one trade, fetched items included, can hold. */
function capacityOf(pool: PyrelayPool, botGuid: string): number {
  const c = pool.capacities?.[botGuid];
  return Number.isInteger(c) && c! > 0 ? c! : 8;
}

/** One trade of a withdraw: the bot, what it hands over, and the copies when they are picked (they sit on another character of the account, which the fleet logs in as). */
type Trade = { botGuid: string; items: (ItemReq & { enchants?: number })[]; instanceIds?: string[] };
type PotionCopy = { instanceId: string; itemId: string; enchants: number };
/** What one account could hand over of a stat's potions (advanced management): by count off the played character and its containers, copy by copy off its other characters. */
type AccountPotions = {
  primary: Map<string, number>;
  chars: Map<number, { capacity: number; copies: PotionCopy[] }>;
  /** Every copy counted above: its item, and its character when on another one. */
  where: Map<string, { itemId: string; charId: number | null }>;
};

/**
 * Advanced management (docs/relay/ADVANCED.md): each pool account's stock of
 * these potions for one side — the played character's and its containers'
 * (fetched a trade at a time, so not capped at one trade's worth) and its
 * other characters' of that side, each with its own trade slots.
 */
function accountPotions(pool: PyrelayPool, seasonal: boolean, relevant: Set<string>): Map<string, AccountPotions> {
  const meta = pool.botMeta ?? {};
  const out = new Map<string, AccountPotions>();
  const account = (g: string) => {
    let a = out.get(g);
    if (!a) out.set(g, (a = { primary: new Map(), chars: new Map(), where: new Map() }));
    return a;
  };
  for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
    if (!isPoolBot(meta[botGuid], seasonal) || isCommunismBot(meta[botGuid]) || meta[botGuid]?.suspended) continue;
    for (const info of Object.values(slots)) {
      if (!relevant.has(info.itemId)) continue;
      const a = account(botGuid);
      a.primary.set(info.itemId, (a.primary.get(info.itemId) ?? 0) + 1);
      a.where.set(info.instanceId, { itemId: info.itemId, charId: null });
    }
  }
  for (const botGuid of Object.keys(pool.stored ?? {})) {
    if (meta[botGuid]?.suspended || isCommunismBot(meta[botGuid])) continue;
    for (const st of storedFor(pool, botGuid, seasonal)) {
      if (!relevant.has(st.itemId)) continue;
      const a = account(botGuid);
      if (st.where.kind !== "char") {
        a.primary.set(st.itemId, (a.primary.get(st.itemId) ?? 0) + 1);
        a.where.set(st.instanceId, { itemId: st.itemId, charId: null });
        continue;
      }
      let ch = a.chars.get(st.where.charId);
      if (!ch) a.chars.set(st.where.charId, (ch = { capacity: st.where.capacity ?? 8, copies: [] }));
      ch.copies.push({ instanceId: st.instanceId, itemId: st.itemId, enchants: (st.enchantments ?? []).length });
      a.where.set(st.instanceId, { itemId: st.itemId, charId: st.where.charId });
    }
  }
  return out;
}

/**
 * Advanced management: the trades of a bulk potion withdraw. The plan takes
 * the account whose stock just covers the request (else the biggest stacks
 * first, lib/potionPlan.ts); each account's share comes off its played
 * character and containers first — one session, a vault fetch per trade —
 * then off its other characters, the one holding most of what is left first.
 * The trades of one account follow each other, and each is at most what the
 * character serving it can hold.
 */
function advancedPotionTrades(points: number, stock: Map<string, AccountPotions>, ids: { normal: string; greater: string }, capacity: (botGuid: string) => number): { plan: PotionWithdrawPlan; trades: Trade[] } {
  const count = (a: AccountPotions, itemId: string) => (a.primary.get(itemId) ?? 0) + [...a.chars.values()].reduce((n, ch) => n + ch.copies.filter((c) => c.itemId === itemId).length, 0);
  const botStock = [...stock].map(([botGuid, a]) => ({ botGuid, normal: count(a, ids.normal), greater: count(a, ids.greater) }));
  const plan = planPotionWithdraw(points, botStock, ids, capacity, { bestFit: true });
  const share = new Map<string, { greater: number; normal: number }>();
  for (const f of plan.fragments) {
    const sh = share.get(f.botGuid) ?? { greater: 0, normal: 0 };
    sh.greater += f.items[ids.greater] ?? 0;
    sh.normal += f.items[ids.normal] ?? 0;
    share.set(f.botGuid, sh);
  }
  const trades: Trade[] = [];
  for (const [botGuid, want] of share) {
    const a = stock.get(botGuid)!;
    // The played character and its containers, by type: a trade's worth at a time, greaters first.
    let g = Math.min(want.greater, a.primary.get(ids.greater) ?? 0);
    let n = Math.min(want.normal, a.primary.get(ids.normal) ?? 0);
    const cap = Math.max(1, capacity(botGuid));
    while (g + n > 0) {
      const tg = Math.min(g, cap);
      const tn = Math.min(n, cap - tg);
      trades.push({ botGuid, items: [...(tg ? [{ itemId: ids.greater, qty: tg }] : []), ...(tn ? [{ itemId: ids.normal, qty: tn }] : [])] });
      g -= tg;
      n -= tn;
    }
    // The rest off its other characters, copy by copy.
    g = want.greater - Math.min(want.greater, a.primary.get(ids.greater) ?? 0);
    n = want.normal - Math.min(want.normal, a.primary.get(ids.normal) ?? 0);
    const chars = [...a.chars].map(([charId, ch]) => ({ charId, capacity: Math.max(1, ch.capacity), greater: ch.copies.filter((c) => c.itemId === ids.greater), normal: ch.copies.filter((c) => c.itemId === ids.normal) }));
    while (g + n > 0) {
      const useful = (c: (typeof chars)[number]) => Math.min(g, c.greater.length) + Math.min(n, c.normal.length);
      chars.sort((x, y) => useful(y) - useful(x) || x.charId - y.charId);
      const c = chars[0];
      if (!c || useful(c) === 0) break;
      const picked = [...c.greater.splice(0, Math.min(g, c.greater.length)), ...c.normal.splice(0, Math.min(n, c.normal.length))];
      g -= picked.filter((p) => p.itemId === ids.greater).length;
      n -= picked.filter((p) => p.itemId === ids.normal).length;
      for (let i = 0; i < picked.length; i += c.capacity) {
        const chunk = picked.slice(i, i + c.capacity);
        const lines = new Map<string, ItemReq & { enchants: number }>();
        for (const p of chunk) {
          const k = `${p.itemId}:${p.enchants}`;
          const cur = lines.get(k);
          if (cur) cur.qty++;
          else lines.set(k, { itemId: p.itemId, qty: 1, enchants: p.enchants });
        }
        trades.push({ botGuid, items: [...lines.values()].sort((x, y) => x.itemId.localeCompare(y.itemId) || x.enchants - y.enchants), instanceIds: chunk.map((p) => p.instanceId).sort() });
      }
    }
  }
  return { plan, trades };
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`withdraw:${ip}`, 5, 5 / 60)) {
    return json({ error: "Too many requests" }, { status: 429 });
  }

  // IGN is authoritative from the session, never the request body.
  const session = sessionFromRequest(req);
  if (!session) {
    return json({ error: "Log in to withdraw." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  (body as Record<string, unknown>).ign = session.ign;
  const parsed = parseWithdrawRequest(body);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });

  const db = getDb();

  const block = withdrawBlock(db, parsed.server);
  if (block) return json({ error: blockMessage(parsed.server, "withdraw", block) }, { status: 403 });
  sweepStaleRequests(db);

  console.log(
    `[withdraw] new req from ign=${parsed.ign} server=${parsed.server} ` +
    `pool=${parsed.seasonal ? "seasonal" : "nonseasonal"} ` +
    `mode=${parsed.potion ? "bulk-potion" : parsed.instanceIds ? "per-instance" : "aggregate"} ` +
    `items=[${(parsed.instanceIds ?? parsed.itemIds ?? []).join(",")}]` +
    `${parsed.potion ? ` potion=${parsed.potion.stat}:${parsed.potion.points}pts` : ""}`,
  );

  // Open-queue gate, shared by both branches below (each still repeats it
  // inside its write transaction, which is what actually enforces it against
  // concurrent submits). Refusing here lets the UI offer a one-click cancel of
  // the wedged queue — the player is logged in, so it's just POST /api/cancel
  // on their own session (no whispered code needed anymore).
  if (openRequestsFor(db, parsed.ignLower).withdraws >= maxOpenWithdraws()) {
    return json(
      {
        error: "Too many open withdraw requests for this IGN — finish one first.",
        hasOpen: true,
      },
      { status: 429 },
    );
  }

  // Per-instance branch: the user picked specific physical items in the
  // pool grid. We look each one up live in pyrelay's /pool (the source of
  // truth), group by their bot, reject if any instance is already reserved
  // by another open per-instance withdraw, and write the rows with
  // instance_ids_json set.
  if (parsed.instanceIds) {
    return await handleInstanceWithdraw(parsed, db);
  }

  // Aggregate branch: item-type only. The fragmenter picks bots. Bulk potion
  // mode joins this path too — it just derives its counts from live stock
  // below instead of from an explicit item list.
  const counts = new Map<string, number>();
  for (const id of parsed.itemIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);

  // Pyrelay owns the inventory truth now. Fetch the snapshot before opening
  // the transaction (the SQLite transaction is sync). If pyrelay is
  // unreachable, fail closed: the user gets a 503 rather than us creating
  // a request the dispatcher can never fulfill.
  const poolResp = await pyrelay.pool();
  if (!poolResp.ok) {
    return json(
      { error: "Bot service unavailable — try again in a minute." },
      { status: 503 },
    );
  }
  // Build a per-bot map filtered to just the items the user is requesting,
  // so the fragmenter sees a small, focused view. Bots of the other pool are
  // left out: the player is standing on a character of one type and no bot
  // of the other type can hand them anything, so their stock isn't stock as
  // far as this request is concerned.
  const meta = poolResp.data.botMeta ?? {};

  // Which item ids the fragmenter needs to see. In bulk potion mode the
  // concrete counts aren't known yet (they depend on post-reservation stock,
  // computed inside the transaction), so we admit both grades of the stat.
  let potionPlan: PotionWithdrawPlan | null = null;
  const relevantIds: Set<string> = parsed.potion
    ? new Set([POTION_IDS[parsed.potion.stat].normal, POTION_IDS[parsed.potion.stat].greater])
    : new Set(counts.keys());
  // Counted from the per-instance view rather than the per-type totals.
  // Communism accounts are not pool stock: communism is taken from item by
  // item, never by type.
  const inventoryFromPyrelay = new Map<string, Map<string, number>>();
  const onCharacter = new Map<string, number>();
  for (const [botGuid, slots] of Object.entries(poolResp.data.instances ?? {})) {
    if (!isPoolBot(meta[botGuid], parsed.seasonal) || isCommunismBot(meta[botGuid])) continue;
    for (const info of Object.values(slots)) {
      onCharacter.set(botGuid, (onCharacter.get(botGuid) ?? 0) + 1);
      if (!relevantIds.has(info.itemId)) continue;
      let m = inventoryFromPyrelay.get(botGuid);
      if (!m) {
        m = new Map();
        inventoryFromPyrelay.set(botGuid, m);
      }
      m.set(info.itemId, (m.get(info.itemId) ?? 0) + 1);
    }
  }
  // The accounts' containers (vault chests, potion rack, gift and spoils
  // chests) are stock too: the fleet fetches what a request needs onto the
  // character first. Another character's items are not counted here — a
  // count of a type is filled from the containers only; those are picked
  // item by item. Per bot no more than the character's slots can hold in
  // one trade, what it already carries included.
  for (const [botGuid, list] of Object.entries(poolResp.data.stored ?? {})) {
    if (meta[botGuid]?.suspended || isCommunismBot(meta[botGuid])) continue;
    let room = capacityOf(poolResp.data, botGuid) - (onCharacter.get(botGuid) ?? 0);
    for (const s of storedFor(poolResp.data, botGuid, parsed.seasonal)) {
      if (room <= 0) break;
      if (s.where.kind === "char" || !relevantIds.has(s.itemId)) continue;
      let m = inventoryFromPyrelay.get(botGuid);
      if (!m) {
        m = new Map();
        inventoryFromPyrelay.set(botGuid, m);
      }
      m.set(s.itemId, (m.get(s.itemId) ?? 0) + 1);
      room--;
    }
    void list;
  }
  // Advanced management on the pool: a bulk potion withdraw counts each
  // account's whole stock of the stat, other characters included, and is
  // served account by account (advancedPotionTrades).
  const advancedStock = parsed.potion && advancedForPool(false) ? accountPotions(poolResp.data, parsed.seasonal, relevantIds) : null;

  // Single transaction: per-IGN cap, total stock check, fragmentation across
  // bots, and N inserts under one group_id. Two concurrent submitters can't
  // race past the stock check because the second waits on the immediate
  // write lock until the first commits its inserts (which mutate the
  // committed-stock view via items_json on the new rows).
  const tx = db.transaction(() => {
    const openCount = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT group_id) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL",
        )
        .get(parsed.ignLower) as { n: number }
    ).n;
    if (openCount >= maxOpenWithdraws()) {
      return { kind: "err" as const, status: 429, error: "Too many open withdraw requests for this IGN — finish one first." };
    }

    // Working copy so deductions for committed withdraws don't mutate the
    // pyrelay snapshot (it's the source of truth and other handlers may
    // observe it within this request lifetime).
    const inventoryByBot = new Map<string, Map<string, number>>();
    for (const [botGuid, items] of inventoryFromPyrelay) {
      inventoryByBot.set(botGuid, new Map(items));
    }

    // Subtract items already committed to other open withdraws (only counting
    // those targeted at one of these bots, so the "available" view matches
    // what fragmentation can actually allocate).
    //
    // We also subtract withdraws that just fulfilled within the last
    // INVENTORY_REFRESH_WINDOW_MS. Pyrelay refreshes the bot's inventory
    // tracker only after a trade completes (~one dispatcher tick), so for
    // a brief window pyrelay.pool() still shows items the bot just gave
    // away. Without this, a back-to-back withdraw for the same item would
    // get pinned to the same bot and be unfulfillable.
    const INVENTORY_REFRESH_WINDOW_MS = 10_000;
    const openRows = db
      .prepare(
        `SELECT items_json, target_bot_guid, instance_ids_json FROM withdraw_requests
         WHERE status IN ('pending','claimed')
            OR (status = 'fulfilled' AND updated_at >= ?)`,
      )
      .all(Date.now() - INVENTORY_REFRESH_WINDOW_MS) as {
      items_json: string;
      target_bot_guid: string | null;
      instance_ids_json: string | null;
    }[];
    for (const row of openRows) {
      let parsedItems: ItemReq[];
      try {
        parsedItems = JSON.parse(row.items_json);
        if (!Array.isArray(parsedItems)) continue;
      } catch {
        continue;
      }
      // If a row targets a specific bot, deduct only from that bot. If
      // unfragmented (no target), deduct from the union — but rows we
      // create here always have a target so this branch only matters for
      // legacy rows during the upgrade.
      if (row.target_bot_guid) {
        const inv = inventoryByBot.get(row.target_bot_guid);
        if (!inv) continue;
        for (const it of parsedItems) {
          inv.set(it.itemId, Math.max(0, (inv.get(it.itemId) ?? 0) - it.qty));
        }
      } else {
        // Legacy rows: drain the items from any bot that has them, in
        // bot_guid sort order so the fragmentation below sees a consistent
        // post-deduction state.
        const sortedBots = [...inventoryByBot.keys()].sort();
        for (const it of parsedItems) {
          let stillCommitted = it.qty;
          for (const botGuid of sortedBots) {
            if (stillCommitted <= 0) break;
            const inv = inventoryByBot.get(botGuid)!;
            const have = inv.get(it.itemId) ?? 0;
            const take = Math.min(have, stillCommitted);
            if (take > 0) {
              inv.set(it.itemId, have - take);
              stillCommitted -= take;
            }
          }
        }
      }
    }

    // Bulk potion mode sizes itself HERE, not from the raw pyrelay snapshot,
    // because the numbers above have already had other players' open
    // withdraws deducted. Planning against raw stock would happily promise
    // potions that are spoken for, and the fragmenter would then reject the
    // whole request with a confusing "only 0 available" — instead of just
    // filling what's genuinely free and saying so.
    let potionFragments: Trade[] | null = null;
    if (parsed.potion && advancedStock) {
      // What other requests count on, account by account: a picked copy is
      // taken out where it sits; a count of a type comes off the played
      // character and its containers, where a by-type row is served from.
      // Copies something else has spoken for (a meeting, a hand-over) stay put.
      const spoken = reservedInstanceIds(db, { openOffers: false });
      for (const a of advancedStock.values()) for (const ch of a.chars.values()) ch.copies = ch.copies.filter((c) => !spoken.has(c.instanceId));
      for (const row of openRows) {
        const a = row.target_bot_guid ? advancedStock.get(row.target_bot_guid) : undefined;
        if (!a) continue;
        try {
          if (row.instance_ids_json !== null) {
            const named = JSON.parse(row.instance_ids_json) as unknown;
            if (!Array.isArray(named)) continue;
            for (const id of named.map(String)) {
              const w = a.where.get(id);
              if (!w) continue;
              if (w.charId === null) a.primary.set(w.itemId, Math.max(0, (a.primary.get(w.itemId) ?? 0) - 1));
              else {
                const ch = a.chars.get(w.charId);
                if (ch) ch.copies = ch.copies.filter((c) => c.instanceId !== id);
              }
            }
          } else {
            const items = JSON.parse(row.items_json) as ItemReq[];
            if (!Array.isArray(items)) continue;
            for (const it of items) if (relevantIds.has(it.itemId)) a.primary.set(it.itemId, Math.max(0, (a.primary.get(it.itemId) ?? 0) - it.qty));
          }
        } catch {
          // a malformed row promises nothing
        }
      }
      const { plan, trades } = advancedPotionTrades(parsed.potion.points, advancedStock, POTION_IDS[parsed.potion.stat], (botGuid) => capacityOf(poolResp.data, botGuid));
      if (plan.pointsFilled === 0) {
        return {
          kind: "err" as const,
          status: 409,
          error:
            `No ${STAT_LABELS[parsed.potion.stat]} potions are available in the ` +
            `${parsed.seasonal ? "seasonal" : "non-seasonal"} pool right now.`,
        };
      }
      potionPlan = plan;
      potionFragments = trades;
      counts.clear();
      for (const [itemId, qty] of Object.entries(plan.items)) counts.set(itemId, qty);
      console.log(
        `[withdraw] bulk potion ${parsed.potion.stat} (advanced) want=${parsed.potion.points} ` +
        `accounts=${advancedStock.size} -> ${trades.length} trade(s) ` +
        `${JSON.stringify(plan.items)} filled=${plan.pointsFilled} ` +
        `short=${plan.shortfall} over=${plan.overshoot}`,
      );
    } else if (parsed.potion) {
      const ids = POTION_IDS[parsed.potion.stat];
      const botStock = [...inventoryByBot.entries()].map(([botGuid, inv]) => ({
        botGuid,
        normal: Math.max(0, inv.get(ids.normal) ?? 0),
        greater: Math.max(0, inv.get(ids.greater) ?? 0),
      }));
      // Each bot's own trade slots per trade (8, 16 or 24): fewer, fuller trades.
      const plan = planPotionWithdraw(parsed.potion.points, botStock, ids, (botGuid) => capacityOf(poolResp.data, botGuid));
      if (plan.pointsFilled === 0) {
        return {
          kind: "err" as const,
          status: 409,
          error:
            `No ${STAT_LABELS[parsed.potion.stat]} potions are available in the ` +
            `${parsed.seasonal ? "seasonal" : "non-seasonal"} pool right now.`,
        };
      }
      potionPlan = plan;
      // The plan already decided which bot hands over what, packing each one
      // as full as the request allows. Running it back through
      // fragmentWithdraw would undo that — the generic fragmenter walks bots
      // in guid order, which spreads the same potions over more trades.
      potionFragments = plan.fragments.map((f) => ({
        botGuid: f.botGuid,
        items: Object.entries(f.items).map(([itemId, qty]) => ({ itemId, qty })),
      }));
      counts.clear();
      for (const [itemId, qty] of Object.entries(plan.items)) {
        counts.set(itemId, qty);
      }
      console.log(
        `[withdraw] bulk potion ${parsed.potion.stat} want=${parsed.potion.points} ` +
        `bots=${botStock.length} -> ${plan.fragments.length} trade(s) ` +
        `${JSON.stringify(plan.items)} filled=${plan.pointsFilled} ` +
        `short=${plan.shortfall} over=${plan.overshoot}`,
      );
    }

    // Operator-imposed per-player cap (dev console). Checked inside the write
    // transaction so a burst of parallel submits can't slip past it, and after
    // bulk sizing so it sees the real item count.
    const requestedCount = [...counts.values()].reduce((a, b) => a + b, 0);
    const allowance = checkWithdrawAllowance(db, parsed.ignLower, requestedCount);
    if (!allowance.ok) {
      return { kind: "err" as const, status: 429, error: allowance.error };
    }

    // Run the fragmenter against post-deduction inventory.
    const request: ItemReq[] = [...counts.entries()].map(([itemId, qty]) => ({ itemId, qty }));
    const bots = [...inventoryByBot.entries()].map(([botGuid, inventory]) => ({
      botGuid,
      inventory,
    }));
    console.log(
      `[withdraw] fragmenter input: request=[${request
        .map((r) => `${r.itemId}:${r.qty}`)
        .join(",")}] bot-count=${bots.length} bots=[${bots
        .map((b) => `${b.botGuid.slice(0, 8)}(${[...b.inventory.entries()]
          .map(([id, q]) => `${id}:${q}`)
          .join("|")})`)
        .join(" ")}]`,
    );
    const result: { ok: true; fragments: Trade[] } | { ok: false; missing: ItemReq[] } = potionFragments
      ? { ok: true as const, fragments: potionFragments }
      : fragmentWithdraw(request, bots);
    if (!result.ok) {
      console.log(
        `[withdraw] fragmenter FAILED missing=[${result.missing
          .map((m) => `${m.itemId}:${m.qty}`)
          .join(",")}]`,
      );
      // Surface the first missing item — most actionable for the user.
      const m = result.missing[0];
      const name = ITEM_BY_ID.get(m.itemId)?.name ?? m.itemId;
      return {
        kind: "err" as const,
        status: 409,
        error:
          `Only ${(counts.get(m.itemId) ?? 0) - m.qty}× ${name} available in the ` +
          `${parsed.seasonal ? "seasonal" : "non-seasonal"} pool right now ` +
          `(others are reserved by pending withdraws).`,
      };
    }

    const groupId = crypto.randomUUID();
    const now = Date.now();
    const insertStmt = db.prepare(
      `INSERT INTO withdraw_requests
       (ign, ign_lower, server, items_json, status, group_id, target_bot_guid,
        seasonal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    );
    // A trade of copies on another character of the account (advanced
    // potion withdraws): pinned to those copies, so the fleet logs the
    // account in as that character for it.
    const pickedStmt = db.prepare(
      `INSERT INTO withdraw_requests
       (ign, ign_lower, server, items_json, status, group_id, target_bot_guid,
        instance_ids_json, seasonal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    );
    const childIds: number[] = [];
    for (const frag of result.fragments) {
      const fragJson = JSON.stringify(
        [...frag.items].sort((a, b) => a.itemId.localeCompare(b.itemId)),
      );
      const r = frag.instanceIds
        ? pickedStmt.run(parsed.ign, parsed.ignLower, parsed.server, fragJson, groupId, frag.botGuid, JSON.stringify(frag.instanceIds), parsed.seasonal ? 1 : 0, now, now)
        : insertStmt.run(
            parsed.ign,
            parsed.ignLower,
            parsed.server,
            fragJson,
            groupId,
            frag.botGuid,
            parsed.seasonal ? 1 : 0,
            now,
            now,
          );
      childIds.push(Number(r.lastInsertRowid));
    }
    console.log(
      `[withdraw] fragmented into ${result.fragments.length} row(s): ` +
      result.fragments
        .map((f, i) => `req#${childIds[i]}->${f.botGuid.slice(0, 8)}[${f.items
          .map((it) => `${it.itemId}:${it.qty}`)
          .join(",")}]`)
        .join(" "),
    );
    return {
      kind: "ok" as const,
      groupId,
      tradeCount: result.fragments.length,
      childIds,
      potionPlan,
      picked: result.fragments.flatMap((f) => f.instanceIds ?? []),
    };
  }).immediate();

  if (tx.kind === "err") {
    return json({ error: tx.error }, { status: tx.status });
  }
  notifyPendingChange();
  // Copies picked off other characters: the node's open offers naming them go, as for a pick in the grid.
  if (tx.picked.length) void swaps()?.withdrawOffersNaming(tx.picked, `a withdraw for ${parsed.ign} took its items`).catch((e) => console.error("[withdraw] withdrawing offers failed:", e));
  return json({
    ok: true,
    groupId: tx.groupId,
    // Bulk potion mode only: what the plan actually covers.
    ...(tx.potionPlan && parsed.potion
      ? {
          potion: {
            stat: parsed.potion.stat,
            pointsRequested: parsed.potion.points,
            pointsFilled: tx.potionPlan.pointsFilled,
            shortfall: tx.potionPlan.shortfall,
            overshoot: tx.potionPlan.overshoot,
            items: tx.potionPlan.items,
          },
        }
      : {}),
    tradeCount: tx.tradeCount,
    // Returned for backwards compatibility — the existing UI used `requestId`.
    // We hand back the FIRST child id; clients should migrate to groupId.
    requestId: tx.childIds[0],
  });
}

// Per-instance withdraw: the user clicked specific physical items in the
// pool grid. Each instance is pinned to its current bot, so we group by
// bot and create one row per bot. Per-IGN cap, double-reserve check, and
// inserts all run in one immediate transaction.
async function handleInstanceWithdraw(parsed: WithdrawReq, db: Database.Database) {
  const instanceIds = parsed.instanceIds!;
  // Pyrelay is the source of truth for inventory — look each instance up
  // there to find which bot currently holds it.
  const poolResp = await pyrelay.pool();
  if (!poolResp.ok) {
    return json(
      { error: "Bot service unavailable — try again in a minute." },
      { status: 503 },
    );
  }
  type InstRow = {
    instance_id: string;
    bot_guid: string;
    item_id: string;
    // Enchantment count captured at submit time — the instance is gone from
    // the tracker by fulfill time, and the ledger's enchant-multiplier
    // scoring needs it recorded on the transaction row.
    enchants: number;
    /** In the account's storage rather than on the character: the fleet fetches it first. A character's id when on another character. */
    stored: { kind: string; charId: number | null; label: string; capacity: number | null } | null;
  };
  const instRows: InstRow[] = [];
  const meta = poolResp.data.botMeta ?? {};
  const onCharacter = new Map<string, number>();
  for (const [botGuid, slots] of Object.entries(poolResp.data.instances ?? {})) {
    // Hard gate, not just display: an instanceId on a bot of the other pool
    // is held by a character this player can't trade, and a communism pick
    // comes off a communism account only (a pool pick never does). Skipping
    // it here makes the request 409 as "no longer available" even if the id
    // was forged into the request body — the UI's tabs are a convenience,
    // this is the enforcement.
    if (!isPoolBot(meta[botGuid], parsed.seasonal) || isCommunismBot(meta[botGuid]) !== parsed.communism) continue;
    for (const info of Object.values(slots)) {
      onCharacter.set(botGuid, (onCharacter.get(botGuid) ?? 0) + 1);
      if (instanceIds.includes(info.instanceId)) {
        instRows.push({
          instance_id: info.instanceId,
          bot_guid: botGuid,
          item_id: info.itemId,
          enchants: (info.enchantments ?? []).length,
          stored: null,
        });
      }
    }
  }
  // Items in an account's storage: the same gate, per item (a vault item
  // serves whichever side the account has a character for, the spoils
  // chest only the non-seasonal side, another character its own side).
  for (const [botGuid] of Object.entries(poolResp.data.stored ?? {})) {
    if (meta[botGuid]?.suspended || isCommunismBot(meta[botGuid]) !== parsed.communism) continue;
    for (const s of storedFor(poolResp.data, botGuid, parsed.seasonal)) {
      if (!instanceIds.includes(s.instanceId)) continue;
      instRows.push({
        instance_id: s.instanceId,
        bot_guid: botGuid,
        item_id: s.itemId,
        enchants: (s.enchantments ?? []).length,
        stored: { kind: s.where.kind, charId: s.where.kind === "char" ? s.where.charId : null, label: whereLabel(s.where), capacity: s.where.kind === "char" ? s.where.capacity ?? 8 : null },
      });
    }
  }

  if (instRows.length !== instanceIds.length) {
    const found = new Set(instRows.map((r) => r.instance_id));
    const missing = instanceIds.find((id) => !found.has(id));
    return json(
      { error: `Item no longer available: ${missing}` },
      { status: 409 },
    );
  }

  // Copies of each type per bot that a by-type withdraw could draw on: the
  // played character's and the containers' (not another character's, which
  // by-type rows never reach), counted the way the by-type branch counts them.
  const stockByBot = new Map<string, Map<string, number>>();
  const bump = (g: string, id: string) => {
    let m = stockByBot.get(g);
    if (!m) stockByBot.set(g, (m = new Map()));
    m.set(id, (m.get(id) ?? 0) + 1);
  };
  for (const [botGuid, slots] of Object.entries(poolResp.data.instances ?? {})) for (const info of Object.values(slots)) bump(botGuid, info.itemId);
  for (const botGuid of Object.keys(poolResp.data.stored ?? {})) for (const st of storedFor(poolResp.data, botGuid, parsed.seasonal)) if (st.where.kind !== "char") bump(botGuid, st.itemId);

  // One trade is one character: what a bot hands over must all be reachable
  // by the character it plays. Picks on several characters of one account
  // become a trade per character, one after another: the fleet serves a
  // player's rows in order and logs the account in as each character in
  // turn (Dispatcher.applyCharSwitches). The played character's trade goes
  // first, with anything fetched from the account's containers onto it.
  // Each trade has only its character's slots to land in.
  const trades = new Map<string, InstRow[]>();
  for (const r of instRows) {
    const key = `${r.bot_guid}|${r.stored?.charId != null ? `c${r.stored.charId}` : "played"}`;
    trades.set(key, [...(trades.get(key) ?? []), r]);
  }
  for (const rows of trades.values()) {
    const botGuid = rows[0].bot_guid;
    // Picks on another character: that character plays the trade, so its slots bound it.
    const cap = rows[0].stored?.charId != null ? rows[0].stored.capacity ?? 8 : capacityOf(poolResp.data, botGuid);
    if (rows.length > cap) {
      return json({ error: `${meta[botGuid]?.ign || "That account"} can hand over at most ${cap} items in one trade (its character's slots). Pick fewer from it.` }, { status: 409 });
    }
  }

  // For ONLINE bots holding selected items, all must be on the server the
  // user picked. Offline bots (botMeta.online === false or missing) get
  // a pass — the dispatcher will wake them onto the requested server when
  // it sees the pending row.
  const wrongServer = instRows.find((r) => {
    const m = meta[r.bot_guid];
    // A stored item is fetched by a fresh login: the bot's current server does not bind it.
    if (!m || !m.online || r.stored) return false;
    return (m.server ?? "") !== parsed.server;
  });
  if (wrongServer) {
    return json(
      {
        error:
          "One or more selected items are on a different server right now. " +
          "Refresh and try again.",
      },
      { status: 409 },
    );
  }

  // One fragment per trade: per bot, and per character of that bot.

  const tx = db.transaction(() => {
    const openCount = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT group_id) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL",
        )
        .get(parsed.ignLower) as { n: number }
    ).n;
    if (openCount >= maxOpenWithdraws()) {
      return {
        kind: "err" as const,
        status: 429,
        error: "Too many open withdraw requests for this IGN — finish one first.",
      };
    }

    // Operator-imposed per-player cap (dev console) — same check as the
    // aggregate branch; one physical instance = one item against the cap.
    const allowance = checkWithdrawAllowance(db, parsed.ignLower, instanceIds.length);
    if (!allowance.ok) {
      return { kind: "err" as const, status: 429, error: allowance.error };
    }

    // Check none of these instances are already spoken for: another open
    // per-instance withdraw, a meeting under way, a hand-over on its way
    // (lib/reservations.ts). An open offer does not hold its items back:
    // the withdraw wins, and the offers naming them are withdrawn below.
    const reserved = reservedInstanceIds(db, { openOffers: false });
    const collision = instanceIds.find((id) => reserved.has(id));
    if (collision) {
      return {
        kind: "err" as const,
        status: 409,
        error: "One of those items is spoken for (an open withdraw, a trade under way, or a hand-over). Refresh and try again.",
      };
    }
    // A by-type withdraw promises copies of a type on a bot without naming
    // them: a pick must leave enough copies for every open row on that bot.
    const short = picksOverCommitted(db, instRows, stockByBot);
    if (short) {
      return {
        kind: "err" as const,
        status: 409,
        error: `Every ${ITEM_BY_ID.get(short)?.name ?? short} on that account is already promised to an open withdraw. Refresh and try again.`,
      };
    }

    const groupId = crypto.randomUUID();
    const now = Date.now();
    const insertStmt = db.prepare(
      `INSERT INTO withdraw_requests
       (ign, ign_lower, server, items_json, status, group_id, target_bot_guid,
        instance_ids_json, seasonal, communism, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const childIds: number[] = [];
    // A deterministic order across retries: bots by id, each bot's played character first, then its other characters.
    const keys = [...trades.keys()].sort((a, b) => {
      const [ga, ca] = a.split("|"), [gb, cb] = b.split("|");
      return ga.localeCompare(gb) || Number(cb === "played") - Number(ca === "played") || ca.localeCompare(cb, undefined, { numeric: true });
    });
    for (const key of keys) {
      const rows = trades.get(key)!;
      const botGuid = rows[0].bot_guid;
      // items_json entries keep the legacy {itemId, qty} keys (coverage
      // checks and the bot's offer builder read only those) but split by
      // enchant count, so two entries CAN share an itemId — the fulfill
      // route aggregates per item when matching what the bot reports, and
      // writes each entry as its own ledger row with `enchants` intact.
      const counts = new Map<string, { itemId: string; qty: number; enchants: number }>();
      for (const r of rows) {
        const key = `${r.item_id}:${r.enchants}`;
        const cur = counts.get(key);
        if (cur) cur.qty += 1;
        else counts.set(key, { itemId: r.item_id, qty: 1, enchants: r.enchants });
      }
      const itemsJson = JSON.stringify(
        [...counts.values()].sort(
          (a, b) => a.itemId.localeCompare(b.itemId) || a.enchants - b.enchants,
        ),
      );
      const instanceJson = JSON.stringify(rows.map((r) => r.instance_id).sort());
      const res = insertStmt.run(
        parsed.ign,
        parsed.ignLower,
        parsed.server,
        itemsJson,
        groupId,
        botGuid,
        instanceJson,
        parsed.seasonal ? 1 : 0,
        parsed.communism ? 1 : 0,
        now,
        now,
      );
      childIds.push(Number(res.lastInsertRowid));
    }
    return {
      kind: "ok" as const,
      groupId,
      tradeCount: keys.length,
      childIds,
    };
  }).immediate();

  if (tx.kind === "err") {
    return json({ error: tx.error }, { status: tx.status });
  }
  notifyPendingChange();
  // The node's open offers naming these items go: the withdraw has them now.
  void swaps()?.withdrawOffersNaming(instanceIds, `a withdraw for ${parsed.ign} took its items`).catch((e) => console.error("[withdraw] withdrawing offers failed:", e));
  // Container picks are fetched onto the character first; picks on another character are not (the account logs in as it).
  const fetched = instRows.filter((r) => r.stored && r.stored.charId == null).length;
  return json({
    ok: true,
    groupId: tx.groupId,
    tradeCount: tx.tradeCount,
    requestId: tx.childIds[0],
    // How many picks the fleet fetches from storage first (a login and a walk into the Vault before the bot can meet the player).
    fetched,
  });
}

