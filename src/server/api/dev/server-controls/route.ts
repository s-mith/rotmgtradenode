import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { SERVER_SET } from "@/lib/servers";
import { getAllServerControls, setServerControl } from "@/lib/serverControls";

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  return json({ ok: true, controls: getAllServerControls(getDb()) });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const server = body.server;
  if (typeof server !== "string" || !SERVER_SET.has(server)) {
    return json({ error: "Invalid server" }, { status: 400 });
  }

  const depositsDisabled = Boolean(body.depositsDisabled);
  const withdrawsDisabled = Boolean(body.withdrawsDisabled);

  const db = getDb();
  setServerControl(db, server, depositsDisabled, withdrawsDisabled);

  return json({ ok: true, controls: getAllServerControls(db) });
}
