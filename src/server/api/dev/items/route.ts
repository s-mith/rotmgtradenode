import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";
import { CATALOG } from "@/lib/catalog";

// GET  /api/dev/items   -> { policy, accepted, total, everything, catalog: [{ id, name, category }] }
// POST /api/dev/items   { policy }  -> the same, after saving
//
// Which catalog items this node takes in (src/lib/itemPolicy.ts): the rules
// by category, the lowest tier per gear group, and per-item pins. Kept in
// the node's settings file; the bots and the site's forms follow it at once.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const r = await pyrelay.itemPolicyGet();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ...r.data, catalog: CATALOG.map((c) => ({ id: c.id, name: c.name, category: c.category, subtype: c.subtype ?? null })) });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { policy?: unknown } | null;
  if (!body || typeof body !== "object" || !body.policy) return json({ error: "policy required" }, { status: 400 });
  const r = await pyrelay.itemPolicySet(body.policy);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
