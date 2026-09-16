import { json } from "@/server/http";
import { isProd, noteTell } from "@/lib/mockPyrelay";

// DEV-ONLY: the fake chat client (/dev/chat) posts a sent whisper here, standing
// in for a tell reaching the bot in game. { name: senderIgn, text: message }.
// This is the piece that must never exist in prod — it lets the caller claim any
// IGN — hence the guard.
export async function POST(req: Request) {
  if (isProd()) return json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const name = typeof (body as { name?: unknown }).name === "string" ? (body as { name: string }).name.trim() : "";
  const text = typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text : "";
  if (!/^[A-Za-z]{1,32}$/.test(name)) {
    return json({ error: "invalid sender IGN (letters only)" }, { status: 400 });
  }
  const matched = noteTell(name, text);
  return json({ ok: true, matched });
}
