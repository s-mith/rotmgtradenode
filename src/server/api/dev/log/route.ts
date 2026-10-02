import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET /api/dev/log[?n=] — the newest fleet log lines (every line the node
// keeps unless `n` asks for fewer), what the node's console shows, for
// reading a trip's chatter without the terminal.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const n = Number(new URL(req.url).searchParams.get("n")) || undefined;
  const r = await pyrelay.nodeLog(n);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data, { headers: { "Cache-Control": "no-store" } });
}
