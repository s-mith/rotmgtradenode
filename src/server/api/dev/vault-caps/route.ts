import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { bumpAllVaultCaps, vaultCapSummary, VAULT_BLOCK } from "@/lib/vault";

// Operator control of the fleet-wide vault entitlement (lib/vault.ts).
//
// GET  /api/dev/vault-caps — { default, block, accounts, byCap }
// POST /api/dev/vault-caps { delta: 8 | -8 } — raise or lower every
//      account's cap by one block, and the default for new accounts.
//      Returns what was shrunk and which accounts are left over their cap.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  return json({ ok: true, ...vaultCapSummary(getDb()) });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as { delta?: unknown };
  const delta = Number(body.delta);
  if (delta !== VAULT_BLOCK && delta !== -VAULT_BLOCK) return json({ error: `delta must be ${VAULT_BLOCK} or -${VAULT_BLOCK}` }, { status: 400 });
  const result = bumpAllVaultCaps(getDb(), delta);
  console.log(`[dev] vault caps ${delta > 0 ? "raised" : "lowered"} by ${Math.abs(delta)} for ${result.accounts} account(s); default ${result.defaultBefore} -> ${result.defaultAfter}; ${result.shrunk} half(s) shrunk; ${result.overAllocated.length} over cap`);
  return json({ ok: true, ...result, summary: vaultCapSummary(getDb()) });
}
