import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { sessionUser } from "@/lib/users";
import { userHasFeature } from "@/lib/features";
import { pyrelay } from "@/lib/devauth";
import { createRule, deleteRule, listRules, scanWishlists, setRuleEnabled, wishRoom, MAX_GROUPS, MAX_RULES_PER_USER, MAX_SLOTS, MAX_TERMS_PER_GROUP } from "@/lib/wishlist";

// My Wishlist — the caller's standing claims (lib/wishlist.ts).
//
// GET    /api/wishlist            → { access, rules, room: { seasonal, nonseasonal }, limits }
// POST   /api/wishlist            { seasonal, itemId, slotsMin?, slotsExact?, enchants? } → { rule, check }
//        `seasonal` is required: a wish watches one pool half and fills
//        the account's vault for that half.
//        Making a wish runs a scan right away — every wish, oldest first,
//        so an older wish that fits the same item is served before this
//        one. `check` says whether the relay answered, what this wish
//        claimed, or why it was passed over. A claim spends the wish, so
//        `rule` may already be gone.
// PATCH  /api/wishlist            { id, enabled } → { rule }
// DELETE /api/wishlist            { id }
//
// Every write needs the wishlist feature, granted per character from the dev
// console; GET answers for anyone logged in so the page can decide whether
// to show the tab at all.

function limits() {
  return { rules: MAX_RULES_PER_USER, groups: MAX_GROUPS, terms: MAX_TERMS_PER_GROUP, slots: MAX_SLOTS };
}

export async function GET(req: Request) {
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in to see your wishlist." }, { status: 401 });
  const access = userHasFeature(db, me.userId, "wishlist");
  return json({ ok: true, access, rules: access ? listRules(db, me.userId) : [], room: { seasonal: wishRoom(db, me.userId, true), nonseasonal: wishRoom(db, me.userId, false) }, limits: limits() });
}

function gate(req: Request) {
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return { ok: false as const, res: json({ error: "Log in first." }, { status: 401 }) };
  if (!userHasFeature(db, me.userId, "wishlist")) return { ok: false as const, res: json({ error: "Your account doesn't have wishlist access." }, { status: 403 }) };
  return { ok: true as const, db, me };
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`wishlist:${ip}`, 20, 20 / 60)) return json({ error: "Too many requests" }, { status: 429 });
  const g = gate(req);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as { seasonal?: unknown; itemId?: unknown; slotsMin?: unknown; slotsExact?: unknown; enchants?: unknown };
  const r = createRule(g.db, g.me.userId, { seasonal: body.seasonal, itemId: body.itemId, slotsMin: body.slotsMin, slotsExact: body.slotsExact, enchants: body.enchants });
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  const pool = await pyrelay.pool();
  const check = { checked: pool.ok, claimed: null as { instanceId: string; itemId: string } | null, why: null as string | null };
  if (pool.ok) {
    const res = scanWishlists(g.db, pool.data);
    for (const hit of res.hits) console.log(`[wishlist] claimed ${hit.itemId}→user ${hit.userId} (rule ${hit.ruleId}${hit.ruleId === r.rule.id ? ", on creation" : ""})`);
    const hit = res.hits.find((h) => h.ruleId === r.rule.id);
    if (hit) check.claimed = { instanceId: hit.instanceId, itemId: hit.itemId };
    else check.why = res.skipped.find((x) => x.ruleId === r.rule.id)?.why ?? null;
  }
  return json({ ok: true, rule: r.rule, check });
}

function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(req: Request) {
  const g = gate(req);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; enabled?: unknown };
  const id = parseId(body.id);
  if (id === null || typeof body.enabled !== "boolean") return json({ error: "id and enabled are required" }, { status: 400 });
  const rule = setRuleEnabled(g.db, g.me.userId, id, body.enabled);
  if (!rule) return json({ error: "No such rule" }, { status: 404 });
  return json({ ok: true, rule });
}

export async function DELETE(req: Request) {
  const g = gate(req);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = parseId(body.id);
  if (id === null) return json({ error: "id is required" }, { status: 400 });
  if (!deleteRule(g.db, g.me.userId, id)) return json({ error: "No such rule" }, { status: 404 });
  return json({ ok: true });
}
