import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { pyrelay } from "@/lib/devauth";
import { sessionUser } from "@/lib/users";
import { claimInstances, vaultBotCandidates, type ClaimPick } from "@/lib/vault";
import { isPoolBot } from "@/lib/capacity";

const MAX_PER_CLAIM = 8;

// POST /api/vault/claim { instanceIds }
// Move pool items into the caller's vault for their pool half. Instant — no
// trade — and priced like a withdraw of each item. The fleet later packs them
// onto that half's bot.
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`vault-claim:${ip}`, 10, 10 / 60)) return json({ error: "Too many requests" }, { status: 429 });
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in to claim items." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { instanceIds?: unknown };
  if (!Array.isArray(body.instanceIds) || body.instanceIds.length === 0) return json({ error: "Pick at least 1 item." }, { status: 400 });
  if (body.instanceIds.length > MAX_PER_CLAIM) return json({ error: `Max ${MAX_PER_CLAIM} items per claim.` }, { status: 400 });
  const ids: string[] = [];
  for (const raw of body.instanceIds) {
    if (typeof raw !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(raw)) return json({ error: `Invalid instance id: ${String(raw)}` }, { status: 400 });
    if (!ids.includes(raw)) ids.push(raw);
  }

  // The tracker is the source of truth for where an instance is and which
  // pool half holds it; a stale id is refused rather than guessed at.
  const pool = await pyrelay.pool();
  if (!pool.ok) return json({ error: "Bot service unavailable — try again in a minute." }, { status: 503 });
  const meta = pool.data.botMeta ?? {};
  const picks: ClaimPick[] = [];
  for (const [botGuid, slots] of Object.entries(pool.data.instances ?? {})) {
    for (const info of Object.values(slots)) {
      if (!ids.includes(info.instanceId)) continue;
      picks.push({ instanceId: info.instanceId, itemId: info.itemId, enchants: (info.enchantments ?? []).length, botGuid, seasonal: isPoolBot(meta[botGuid], true) });
    }
  }
  if (picks.length !== ids.length) {
    const found = new Set(picks.map((p) => p.instanceId));
    return json({ error: `Item no longer available: ${ids.find((id) => !found.has(id))}` }, { status: 409 });
  }
  const r = claimInstances(db, me, picks, vaultBotCandidates(db, pool.data, picks[0].seasonal, me.userId));
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, claimed: r.claimed, seasonal: r.seasonal, used: r.used, slots: r.slots, botGuid: r.botGuid });
}
