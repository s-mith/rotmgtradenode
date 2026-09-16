import { json } from "@/server/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { startLogin } from "@/lib/login";

// POST /api/login/start
// Mint a login code and register it with the bot fleet. Returns the code and a
// bot IGN; the client shows "/tell <botIgn> <code>" for the player to paste in
// game, then polls /api/login/status until the tell lands.
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`login-start:${ip}`, 5, 5 / 60)) {
    return json({ error: "Too many requests" }, { status: 429 });
  }

  const started = await startLogin();
  if (!started.ok) {
    return json({ error: started.error }, { status: started.status });
  }
  return json({ ok: true, code: started.code, botIgn: started.botIgn });
}
