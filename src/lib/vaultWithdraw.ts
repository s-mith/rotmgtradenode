// Personal storage withdraws as a library call (the /api/withdraw route has
// the same logic for the browser). Phase 4b: the guest coordinator queues
// these on a guest's behalf when the hub hands the node a withdraw request.
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { PyrelayPool } from "./devauth";
import { releaseVaultBotIfEmpty, reservedInstanceIds } from "./vault";

export const MAX_OPEN_VAULT_WITHDRAWS = 4;

export type VaultWithdrawResult = { ok: true; groupId: string; requestIds: number[] } | { ok: false; status: number; error: string };

/**
 * Queue a withdraw of `instanceIds`, all owned by `userId`, to be handed to
 * `ign` on `server`. Rows are pinned to whichever bot holds each item now.
 */
export function createVaultWithdraw(db: Database.Database, pool: PyrelayPool, req: { userId: number; ign: string; server: string; instanceIds: string[] }): VaultWithdrawResult {
  const ids = [...new Set(req.instanceIds)];
  if (!ids.length) return { ok: false, status: 400, error: "Pick at least one item." };
  const owned = db
    .prepare(`SELECT instance_id, item_id, enchants, seasonal FROM vault_items WHERE user_id = ? AND instance_id IN (${ids.map(() => "?").join(",")})`)
    .all(req.userId, ...ids) as { instance_id: string; item_id: string; enchants: number; seasonal: number }[];
  if (owned.length !== ids.length) return { ok: false, status: 409, error: "One of those items isn't in the vault any more." };
  if (owned.some((r) => r.seasonal !== owned[0].seasonal)) return { ok: false, status: 400, error: "Withdraw from one half at a time — seasonal and non-seasonal items ride different bots." };
  const meta = pool.botMeta ?? {};
  const holder = new Map<string, string>();
  for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) for (const info of Object.values(slots)) if (ids.includes(info.instanceId)) holder.set(info.instanceId, botGuid);
  if (ids.some((id) => !holder.has(id))) return { ok: false, status: 409, error: "One of those items is on a bot the node can't reach right now." };
  if (ids.some((id) => { const m = meta[holder.get(id)!]; return !!m && m.online && (m.server ?? "") !== req.server; })) {
    return { ok: false, status: 409, error: "One of those items is on a bot busy on another server right now." };
  }
  const byBot = new Map<string, typeof owned>();
  for (const r of owned) byBot.set(holder.get(r.instance_id)!, [...(byBot.get(holder.get(r.instance_id)!) ?? []), r]);
  const ignLower = req.ign.toLowerCase();
  const tx = db.transaction((): VaultWithdrawResult => {
    const openCount = (db.prepare("SELECT COUNT(*) AS n FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL").get(ignLower) as { n: number }).n;
    if (openCount >= MAX_OPEN_VAULT_WITHDRAWS) return { ok: false, status: 429, error: "Too many open withdraws for this IGN — finish one first." };
    const reserved = reservedInstanceIds(db);
    if (ids.some((id) => reserved.has(id))) return { ok: false, status: 409, error: "One of those items is already in an open withdraw or offer." };
    const groupId = crypto.randomUUID();
    const now = Date.now();
    const ins = db.prepare(`INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, vault_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`);
    const requestIds: number[] = [];
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
      const res = ins.run(req.ign, ignLower, req.server, itemsJson, groupId, botGuid, JSON.stringify(rows.map((r) => r.instance_id).sort()), rows[0].seasonal ? 1 : 0, req.userId, now, now);
      requestIds.push(Number(res.lastInsertRowid));
    }
    return { ok: true, groupId, requestIds };
  }).immediate();
  if (tx.ok) releaseVaultBotIfEmpty(db, req.userId);
  return tx;
}
