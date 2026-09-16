import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { getAllServerControls } from "@/lib/serverControls";
import { serverUsage } from "@/lib/serverUsage";

// Public, no auth. The server pickers poll this: a server is listed when a
// trade may not target it, whether an operator switched it off or Realm
// reports it loaded (the fleet only trades on empty servers). `usage` is
// Realm's load for busy ones, so the picker can say how full.
export async function GET() {
  const controls = getAllServerControls(getDb());
  const disabled: Record<string, { deposits: boolean; withdraws: boolean; busy?: boolean; usage?: number }> = {};
  for (const c of controls) {
    if (c.depositsDisabled || c.withdrawsDisabled || c.busy) {
      disabled[c.server] = {
        deposits: c.depositsDisabled || c.busy,
        withdraws: c.withdrawsDisabled || c.busy,
        ...(c.busy ? { busy: true, usage: c.usage ?? undefined } : {}),
      };
    }
  }
  return json({ disabled, usageFresh: serverUsage.fresh() });
}
