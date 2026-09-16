import { json } from "@/server/http";
import { isProd, state } from "@/lib/mockPyrelay";

// DEV-ONLY mock of pyrelay GET /login/code-state?code=...
export async function GET(req: Request) {
  if (isProd()) return json({ error: "not found" }, { status: 404 });
  const code = new URL(req.url).searchParams.get("code") ?? "";
  if (!/^[A-Za-z0-9]{4,32}$/.test(code)) {
    return json({ error: "invalid code" }, { status: 400 });
  }
  const s = state(code);
  return json({ ok: true, state: s.state, ign: s.ign });
}
