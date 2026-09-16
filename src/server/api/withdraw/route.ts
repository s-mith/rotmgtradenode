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
import { pyrelay } from "@/lib/devauth";
import { MAX_OPEN_WITHDRAWS, openRequestsFor } from "@/lib/cancelCode";
import { isSkinItem } from "@/lib/skins";
import { sessionFromRequest } from "@/lib/session";
import { blockMessage, withdrawBlock } from "@/lib/serverControls";
import { ownedInstanceIds, releaseVaultBotIfEmpty, reservedInstanceIds } from "@/lib/vault";
import { sessionUser } from "@/lib/users";


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
  if (openRequestsFor(db, parsed.ignLower).withdraws >= MAX_OPEN_WITHDRAWS) {
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
  if (parsed.vault) {
    const me = sessionUser(db, req);
    if (!me) return json({ error: "Log in to use your vault." }, { status: 401 });
    return await handleVaultWithdraw(parsed, db, me.userId);
  }
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
  // Counted from the per-instance view rather than the per-type totals, so
  // an item somebody owns (personal storage, whichever bot holds it) is not
  // stock the fragmenter may hand out.
  const owned = ownedInstanceIds(db);
  const inventoryFromPyrelay = new Map<string, Map<string, number>>();
  for (const [botGuid, slots] of Object.entries(poolResp.data.instances ?? {})) {
    if (!isPoolBot(meta[botGuid], parsed.seasonal)) continue;
    for (const info of Object.values(slots)) {
      if (!relevantIds.has(info.itemId) || owned.has(info.instanceId)) continue;
      let m = inventoryFromPyrelay.get(botGuid);
      if (!m) {
        m = new Map();
        inventoryFromPyrelay.set(botGuid, m);
      }
      m.set(info.itemId, (m.get(info.itemId) ?? 0) + 1);
    }
  }

  // Single transaction: per-IGN cap, total stock check, fragmentation across
  // bots, and N inserts under one group_id. Two concurrent submitters can't
  // race past the stock check because the second waits on the immediate
  // write lock until the first commits its inserts (which mutate the
  // committed-stock view via items_json on the new rows).
  const tx = db.transaction(() => {
    const openCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL",
        )
        .get(parsed.ignLower) as { n: number }
    ).n;
    if (openCount >= MAX_OPEN_WITHDRAWS) {
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
        `SELECT items_json, target_bot_guid FROM withdraw_requests
         WHERE status IN ('pending','claimed')
            OR (status = 'fulfilled' AND updated_at >= ?)`,
      )
      .all(Date.now() - INVENTORY_REFRESH_WINDOW_MS) as {
      items_json: string;
      target_bot_guid: string | null;
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
    let potionFragments: { botGuid: string; items: ItemReq[] }[] | null = null;
    if (parsed.potion) {
      const ids = POTION_IDS[parsed.potion.stat];
      const botStock = [...inventoryByBot.entries()].map(([botGuid, inv]) => ({
        botGuid,
        normal: Math.max(0, inv.get(ids.normal) ?? 0),
        greater: Math.max(0, inv.get(ids.greater) ?? 0),
      }));
      const plan = planPotionWithdraw(parsed.potion.points, botStock, ids);
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
    const result = potionFragments
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
    const childIds: number[] = [];
    for (const frag of result.fragments) {
      const fragJson = JSON.stringify(
        [...frag.items].sort((a, b) => a.itemId.localeCompare(b.itemId)),
      );
      const r = insertStmt.run(
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
    };
  }).immediate();

  if (tx.kind === "err") {
    return json({ error: tx.error }, { status: tx.status });
  }
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
  };
  const instRows: InstRow[] = [];
  const meta = poolResp.data.botMeta ?? {};
  const owned = ownedInstanceIds(db);
  for (const [botGuid, slots] of Object.entries(poolResp.data.instances ?? {})) {
    // Hard gate, not just display: an instanceId on a bot of the other pool
    // is held by a character this player can't trade. Skipping it here makes
    // the request 409 as "no longer available" even if the id was forged into
    // the request body — the UI's pool tab is a convenience, this is the
    // enforcement.
    if (!isPoolBot(meta[botGuid], parsed.seasonal)) continue;
    for (const info of Object.values(slots)) {
      // Personal property is not pool stock, whichever bot holds it.
      if (owned.has(info.instanceId)) continue;
      if (instanceIds.includes(info.instanceId)) {
        instRows.push({
          instance_id: info.instanceId,
          bot_guid: botGuid,
          item_id: info.itemId,
          enchants: (info.enchantments ?? []).length,
        });
      }
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
  // Skins are mission rewards, never a pick from the grid (the grid doesn't
  // show them; this stops a hand-built request).
  if (instRows.some((r) => isSkinItem(r.item_id))) {
    return json({ error: "Skins are earned through missions — use the Redeem skin tab." }, { status: 400 });
  }

  // For ONLINE bots holding selected items, all must be on the server the
  // user picked. Offline bots (botMeta.online === false or missing) get
  // a pass — the dispatcher will wake them onto the requested server when
  // it sees the pending row.
  const wrongServer = instRows.find((r) => {
    const m = meta[r.bot_guid];
    if (!m || !m.online) return false;
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

  // Group instances by bot — one fragment per bot.
  const byBot = new Map<string, InstRow[]>();
  for (const r of instRows) {
    const list = byBot.get(r.bot_guid) ?? [];
    list.push(r);
    byBot.set(r.bot_guid, list);
  }

  const tx = db.transaction(() => {
    const openCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL",
        )
        .get(parsed.ignLower) as { n: number }
    ).n;
    if (openCount >= MAX_OPEN_WITHDRAWS) {
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

    // Check none of these instances are already reserved by another
    // open per-instance withdraw. We look for instance_id substring match
    // in instance_ids_json — fine for the small open-request set we keep.
    const reservedRows = db
      .prepare(
        `SELECT instance_ids_json FROM withdraw_requests
         WHERE status IN ('pending','claimed') AND instance_ids_json IS NOT NULL`,
      )
      .all() as { instance_ids_json: string }[];
    const reserved = new Set<string>();
    for (const r of reservedRows) {
      try {
        const arr = JSON.parse(r.instance_ids_json);
        if (Array.isArray(arr)) for (const id of arr) reserved.add(String(id));
      } catch {
        // ignore malformed json on the open row — it'll get cancelled by sweep
      }
    }
    const collision = instanceIds.find((id) => reserved.has(id));
    if (collision) {
      return {
        kind: "err" as const,
        status: 409,
        error: "One of those items was just reserved by someone else. Refresh and try again.",
      };
    }

    const groupId = crypto.randomUUID();
    const now = Date.now();
    const insertStmt = db.prepare(
      `INSERT INTO withdraw_requests
       (ign, ign_lower, server, items_json, status, group_id, target_bot_guid,
        instance_ids_json, seasonal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    );
    const childIds: number[] = [];
    // Sort bots for deterministic fragment order across retries.
    const botGuids = [...byBot.keys()].sort();
    for (const botGuid of botGuids) {
      const rows = byBot.get(botGuid)!;
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
        now,
        now,
      );
      childIds.push(Number(res.lastInsertRowid));
    }
    return {
      kind: "ok" as const,
      groupId,
      tradeCount: botGuids.length,
      childIds,
    };
  }).immediate();

  if (tx.kind === "err") {
    return json({ error: tx.error }, { status: tx.status });
  }
  return json({
    ok: true,
    groupId: tx.groupId,
    tradeCount: tx.tradeCount,
    requestId: tx.childIds[0],
  });
}

// Personal storage: the player takes their own items back. Each named
// instance must be theirs and not already on its way; rows are pinned to
// whichever bot the tracker sees holding the item (the vault bot once the
// fleet has packed it there, a pool bot while it is still in transit). No
// operator cap and no ledger — it is their property, not a draw on the pool.
async function handleVaultWithdraw(parsed: WithdrawReq, db: Database.Database, userId: number) {
  const instanceIds = parsed.instanceIds!;
  const owned = db
    .prepare(`SELECT instance_id, item_id, enchants, seasonal FROM vault_items WHERE user_id = ? AND instance_id IN (${instanceIds.map(() => "?").join(",")})`)
    .all(userId, ...instanceIds) as { instance_id: string; item_id: string; enchants: number; seasonal: number }[];
  if (owned.length !== instanceIds.length) {
    return json({ error: "One of those items isn't in your vault any more. Refresh and try again." }, { status: 409 });
  }
  // The two vaults are on bots of different pools; one trade serves one.
  if (owned.some((r) => r.seasonal !== owned[0].seasonal)) {
    return json({ error: "Withdraw from one vault at a time — seasonal and non-seasonal items ride different bots." }, { status: 400 });
  }
  const poolResp = await pyrelay.pool();
  if (!poolResp.ok) {
    return json({ error: "Bot service unavailable — try again in a minute." }, { status: 503 });
  }
  const meta = poolResp.data.botMeta ?? {};
  const holder = new Map<string, string>();
  for (const [botGuid, slots] of Object.entries(poolResp.data.instances ?? {})) {
    for (const info of Object.values(slots)) if (instanceIds.includes(info.instanceId)) holder.set(info.instanceId, botGuid);
  }
  const missing = instanceIds.find((id) => !holder.has(id));
  if (missing) {
    return json({ error: "One of those items is on a bot the fleet can't reach right now. Try again later." }, { status: 409 });
  }
  const wrongServer = instanceIds.find((id) => {
    const m = meta[holder.get(id)!];
    return !!m && m.online && (m.server ?? "") !== parsed.server;
  });
  if (wrongServer) {
    return json({ error: "One of those items is on a bot that is busy on another server right now. Try again in a minute." }, { status: 409 });
  }
  const byBot = new Map<string, { instance_id: string; item_id: string; enchants: number; seasonal: number }[]>();
  for (const r of owned) {
    const g = holder.get(r.instance_id)!;
    const list = byBot.get(g) ?? [];
    list.push(r);
    byBot.set(g, list);
  }

  const tx = db.transaction(() => {
    const openCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL")
        .get(parsed.ignLower) as { n: number }
    ).n;
    if (openCount >= MAX_OPEN_WITHDRAWS) {
      return { kind: "err" as const, status: 429, error: "Too many open withdraw requests for this IGN — finish one first." };
    }
    const reserved = reservedInstanceIds(db);
    if (instanceIds.some((id) => reserved.has(id))) {
      return { kind: "err" as const, status: 409, error: "One of those items is already in an open withdraw of yours." };
    }
    const groupId = crypto.randomUUID();
    const now = Date.now();
    const insertStmt = db.prepare(
      `INSERT INTO withdraw_requests
       (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, vault_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const childIds: number[] = [];
    for (const botGuid of [...byBot.keys()].sort()) {
      const rows = byBot.get(botGuid)!;
      const counts = new Map<string, { itemId: string; qty: number; enchants: number }>();
      for (const r of rows) {
        const key = `${r.item_id}:${r.enchants}`;
        const cur = counts.get(key);
        if (cur) cur.qty += 1;
        else counts.set(key, { itemId: r.item_id, qty: 1, enchants: r.enchants });
      }
      const itemsJson = JSON.stringify([...counts.values()].sort((a, b) => a.itemId.localeCompare(b.itemId) || a.enchants - b.enchants));
      const res = insertStmt.run(parsed.ign, parsed.ignLower, parsed.server, itemsJson, groupId, botGuid, JSON.stringify(rows.map((r) => r.instance_id).sort()), rows[0].seasonal ? 1 : 0, userId, now, now);
      childIds.push(Number(res.lastInsertRowid));
    }
    return { kind: "ok" as const, groupId, childIds };
  }).immediate();
  if (tx.kind === "err") return json({ error: tx.error }, { status: tx.status });
  // Nothing to release yet (the rows are open), but keep the bookkeeping honest.
  releaseVaultBotIfEmpty(db, userId);
  return json({ ok: true, groupId: tx.groupId, tradeCount: tx.childIds.length, requestIds: tx.childIds, vault: true });
}
