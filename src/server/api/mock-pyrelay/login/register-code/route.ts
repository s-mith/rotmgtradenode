import { json } from "@/server/http";
import { MOCK_BOT_IGN, isProd, register } from "@/lib/mockPyrelay";

// DEV-ONLY mock of pyrelay POST /login/register-code. Registers the code and
// names the (fake) login-desk bot to /tell. Reached because .env.local points
// PYRELAY_URL at /api/mock-pyrelay.
export async function POST(req: Request) {
  if (isProd()) return json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const code = typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : "";
  if (!/^[A-Za-z0-9]{4,32}$/.test(code)) {
    return json({ error: "invalid code" }, { status: 400 });
  }
  register(code);
  return json({ ok: true, botGuid: "mock-bot", botIgn: MOCK_BOT_IGN });
}
