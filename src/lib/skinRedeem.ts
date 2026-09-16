// Skin supply and redemption.
//
// Skins are non-seasonal items, full stop: the operator's skin deposits go
// to non-seasonal bots, and only non-seasonal bots ever hand one over, so a
// player redeems on a non-seasonal character. Supply is whatever those bots
// are holding: the tracker records skins under "skin:<realmId>", and this
// module reads them back out of the pool snapshot — minus instances already
// promised to an open redemption. A skin that somehow sits on a seasonal bot
// is a stray: reported to the operator, never offered.
//
// A redemption is a per-instance withdraw pinned to the bot that holds the
// skin, exactly like picking an item in the grid, plus a skin_redemptions
// row that ties it to the player's mission balance. Its status is the
// withdraw's: fulfilled means delivered, cancelled means the redemption was
// never spent, pending/claimed means a bot is on its way.
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { isPoolBot } from "./capacity";
import { ITEM_BY_ID } from "./catalog";
import type { PyrelayPool } from "./devauth";
import { emitRequest } from "./liveBus";
import { MISSION_DEFS, totalEarned, type MissionStat } from "./missions";
import { POTION_IDS } from "./potionPlan";
import { MAX_OPEN_WITHDRAWS } from "./cancelCode";
import { skinDef, skinItemId, skinRealmId, SKIN_DEFS } from "./skins";

const GREATER_POTION_IDS = new Set(Object.values(POTION_IDS).map((p) => p.greater));

export type SkinInstance = { instanceId: string; botGuid: string; botIgn: string; server: string; online: boolean; seasonal: boolean };
export type SkinStock = { realmId: string; name: string; image: string; count: number };

/** Instances promised to an open per-instance withdraw (any kind). */
export function reservedInstanceIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT instance_ids_json FROM withdraw_requests WHERE status IN ('pending','claimed') AND instance_ids_json IS NOT NULL`)
    .all() as { instance_ids_json: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.instance_ids_json);
      if (Array.isArray(arr)) for (const id of arr) out.add(String(id));
    } catch { /* malformed open row: the sweep will cancel it */ }
  }
  return out;
}

/** realmId -> the unreserved skin instances on non-seasonal bots (`seasonal` = the strays instead). */
export function skinInstances(pool: PyrelayPool, reserved: Set<string> = new Set(), seasonal = false): Map<string, SkinInstance[]> {
  const meta = pool.botMeta ?? {};
  const out = new Map<string, SkinInstance[]>();
  for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
    const m = meta[botGuid];
    if (!isPoolBot(m, seasonal)) continue;
    for (const info of Object.values(slots)) {
      const realmId = skinRealmId(info.itemId);
      if (!realmId || reserved.has(info.instanceId)) continue;
      (out.get(realmId) ?? out.set(realmId, []).get(realmId)!).push({
        instanceId: info.instanceId, botGuid, botIgn: m?.ign ?? "", server: m?.server ?? "", online: !!m?.online, seasonal: m?.seasonal !== false,
      });
    }
  }
  return out;
}

/** What the Redeem skin tab offers: in stock on non-seasonal bots, by name. */
export function skinStock(db: Database.Database, pool: PyrelayPool): SkinStock[] {
  const reserved = reservedInstanceIds(db);
  const out: SkinStock[] = [];
  for (const [realmId, list] of skinInstances(pool, reserved)) {
    const d = skinDef(realmId);
    if (d && list.length) out.push({ realmId, name: d.name, image: d.image, count: list.length });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type OpenRedemption = { id: number; requestId: number; groupId: string; skinId: string; name: string; status: "pending" | "claimed" };
export type MissionProgress = {
  stats: Record<MissionStat, number>;
  earned: number;
  used: number;
  available: number;
  open: OpenRedemption | null;
};

/** A player's mission balance: progress from the ledger, redemptions spent from skin_redemptions. */
export function missionProgress(db: Database.Database, ignLower: string): MissionProgress {
  const rows = db
    .prepare(
      `SELECT t.kind, t.item_id, t.qty, COALESCE(dr.seasonal, wr.seasonal) AS seasonal
         FROM transactions t
         LEFT JOIN deposit_requests  dr ON t.kind = 'deposit'  AND t.request_id = dr.id
         LEFT JOIN withdraw_requests wr ON t.kind = 'withdraw' AND t.request_id = wr.id
        WHERE t.ign_lower = ?`,
    )
    .all(ignLower) as { kind: "deposit" | "withdraw"; item_id: string; qty: number; seasonal: number | null }[];
  let seasonalPotionsNet = 0;
  for (const r of rows) {
    const sign = r.kind === "deposit" ? 1 : -1;
    // Rows without a request link (old ledger) default to seasonal, like the request columns do.
    const seasonal = r.seasonal === null ? true : r.seasonal === 1;
    if (!seasonal) continue;
    if (ITEM_BY_ID.get(r.item_id)?.category === "Potion") seasonalPotionsNet += sign * r.qty * (GREATER_POTION_IDS.has(r.item_id) ? 2 : 1);
  }
  // Reported as-is, negatives included: a player who has withdrawn more than
  // they put in should see the deficit they have to climb out of.
  const stats: Record<MissionStat, number> = { seasonalPotionsNet };
  const earned = totalEarned(stats);
  // A cancelled redemption (the bot never showed, the player cancelled) was never spent.
  const used = (db
    .prepare(`SELECT COUNT(*) AS n FROM skin_redemptions r JOIN withdraw_requests w ON w.id = r.withdraw_request_id WHERE r.ign_lower = ? AND w.status != 'cancelled'`)
    .get(ignLower) as { n: number }).n;
  const openRow = db
    .prepare(`SELECT r.id, r.skin_id, w.id AS request_id, w.group_id, w.status FROM skin_redemptions r JOIN withdraw_requests w ON w.id = r.withdraw_request_id WHERE r.ign_lower = ? AND w.status IN ('pending','claimed') ORDER BY r.id DESC LIMIT 1`)
    .get(ignLower) as { id: number; skin_id: string; request_id: number; group_id: string; status: "pending" | "claimed" } | undefined;
  const open: OpenRedemption | null = openRow
    ? { id: openRow.id, requestId: openRow.request_id, groupId: openRow.group_id, skinId: openRow.skin_id, name: skinDef(openRow.skin_id)?.name ?? openRow.skin_id, status: openRow.status }
    : null;
  return { stats, earned, used, available: Math.max(0, earned - used), open };
}

export type RedeemResult =
  | { ok: true; groupId: string; requestId: number; botIgn: string | null; name: string }
  | { ok: false; status: number; error: string; hasOpen?: boolean };

/**
 * Spend one earned redemption on a skin: pick an unreserved instance held by
 * a non-seasonal bot (an online bot on the player's server first), and queue
 * a per-instance withdraw pinned to that bot. The dispatcher delivers it like
 * any other picked item — to a non-seasonal character.
 */
export function createRedemption(
  db: Database.Database,
  pool: PyrelayPool,
  args: { ign: string; ignLower: string; server: string; skinId: string },
): RedeemResult {
  const def = skinDef(args.skinId);
  if (!def) return { ok: false, status: 400, error: "Unknown skin" };
  const progress = missionProgress(db, args.ignLower);
  if (progress.open) return { ok: false, status: 409, error: `You already have a redemption in progress (${progress.open.name}) — finish or cancel it first.`, hasOpen: true };
  if (progress.available < 1) return { ok: false, status: 403, error: "Complete a mission to earn a skin redemption first." };

  const reserved = reservedInstanceIds(db);
  const candidates = skinInstances(pool, reserved).get(args.skinId) ?? [];
  if (!candidates.length) {
    const strays = skinInstances(pool, reserved, true).get(args.skinId) ?? [];
    return {
      ok: false, status: 409,
      error: strays.length
        ? `${def.name} is out of stock: the only copies sit on seasonal bots, and skins are delivered by non-seasonal bots.`
        : `${def.name} just went out of stock. Refresh and pick another.`,
    };
  }
  candidates.sort((a, b) =>
    Number(b.online && b.server === args.server) - Number(a.online && a.server === args.server) ||
    Number(b.online) - Number(a.online) ||
    a.botIgn.localeCompare(b.botIgn) || a.instanceId.localeCompare(b.instanceId));
  const pick = candidates[0];

  let groupId: string | null = null;
  const out = db.transaction((): RedeemResult => {
    const openCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL`)
      .get(args.ignLower) as { n: number }).n;
    if (openCount >= MAX_OPEN_WITHDRAWS) return { ok: false, status: 429, error: "Too many open withdraw requests for this IGN — finish one first." };
    if (reservedInstanceIds(db).has(pick.instanceId)) return { ok: false, status: 409, error: "That skin was just reserved by someone else. Refresh and try again." };
    const now = Date.now();
    groupId = crypto.randomUUID();
    const res = db
      .prepare(
        `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(args.ign, args.ignLower, args.server, JSON.stringify([{ itemId: skinItemId(args.skinId), qty: 1, enchants: 0 }]), groupId, pick.botGuid, JSON.stringify([pick.instanceId]), 0, now, now);
    const requestId = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO skin_redemptions (ign, ign_lower, skin_id, withdraw_request_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(args.ign, args.ignLower, args.skinId, requestId, now);
    db.prepare("INSERT INTO request_events (kind, request_id, event, bot_guid, detail, at) VALUES ('withdraw', ?, 'created', NULL, ?, ?)")
      .run(requestId, JSON.stringify({ skinRedemption: def.name }), now);
    return { ok: true, groupId, requestId, botIgn: pick.botIgn || null, name: def.name };
  }).immediate();
  if (out.ok) {
    console.log(`[skins] redemption queued: ${def.name} -> withdraw #${out.requestId} on ${pick.botIgn || pick.botGuid.slice(0, 8)}`);
    emitRequest(groupId);
  }
  return out;
}

export type RedemptionRow = { id: number; ign: string; skinId: string; name: string; requestId: number; status: string; botIgn: string | null; createdAt: number };
/** Operator view: recent redemptions, newest first. */
export function listRedemptions(db: Database.Database, botIgnFor: (guid: string | null) => string, limit = 50): RedemptionRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.ign, r.skin_id, r.withdraw_request_id, r.created_at, w.status, w.claimed_by, w.target_bot_guid
         FROM skin_redemptions r JOIN withdraw_requests w ON w.id = r.withdraw_request_id
        ORDER BY r.id DESC LIMIT ?`,
    )
    .all(limit) as { id: number; ign: string; skin_id: string; withdraw_request_id: number; created_at: number; status: string; claimed_by: string | null; target_bot_guid: string | null }[];
  return rows.map((r) => ({
    id: r.id, ign: r.ign, skinId: r.skin_id, name: skinDef(r.skin_id)?.name ?? r.skin_id, requestId: r.withdraw_request_id, status: r.status,
    botIgn: botIgnFor(r.claimed_by) || botIgnFor(r.target_bot_guid) || null, createdAt: r.created_at,
  }));
}

/** Operator view: every skin with what the fleet holds of it, who holds it, and any strays on seasonal bots. */
export function skinInventory(db: Database.Database, pool: PyrelayPool) {
  const reserved = reservedInstanceIds(db);
  const stock = skinInstances(pool, reserved);
  const strays = skinInstances(pool, reserved, true);
  return SKIN_DEFS.map((s) => {
    const held = stock.get(s.realmId) ?? [];
    const stray = strays.get(s.realmId) ?? [];
    return {
      ...s,
      count: held.length,
      holders: [...new Set(held.map((h) => h.botIgn || h.botGuid.slice(0, 8)))].sort(),
      strays: stray.length,
      strayHolders: [...new Set(stray.map((h) => h.botIgn || h.botGuid.slice(0, 8)))].sort(),
    };
  });
}
