import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { sessionUser } from "@/lib/users";
import { allocateVaultSlots } from "@/lib/vault";

// POST /api/vault/allocate { seasonal: boolean, slots: number }
// Set how many of the account's slots its seasonal or non-seasonal vault
// holds. Slots come in blocks of VAULT_BLOCK and the two vaults share the
// account's total, so growing one means shrinking the other first; a vault
// can't shrink below what it holds (items plus wishes).
export async function POST(req: Request) {
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in first." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { seasonal?: unknown; slots?: unknown };
  if (typeof body.seasonal !== "boolean") return json({ error: "seasonal must be true or false" }, { status: 400 });
  const slots = Number(body.slots);
  if (!Number.isInteger(slots) || slots < 0) return json({ error: "slots must be a whole number" }, { status: 400 });
  const r = allocateVaultSlots(db, me, body.seasonal, slots);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, seasonal: r.seasonal, slots: r.slots, unallocated: r.unallocated });
}
