import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { parseDepositRequest } from "@/lib/validation";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { createDepositRequest } from "@/lib/depositRequest";
import { sessionFromRequest } from "@/lib/session";
import { blockMessage, depositBlock } from "@/lib/serverControls";

// POST /api/deposit — the website's deposit form.
//
// Everything past "which IGN is this for?" lives in lib/depositRequest.ts,
// shared with the automation API (/api/ext/deposit) so the two can't disagree
// about queue gates or vault capacity.
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`deposit:${ip}`, 10, 10 / 60)) {
    return json({ error: "Too many requests" }, { status: 429 });
  }

  // IGN is authoritative from the session, never the request body — the player
  // proved control of the character at login (lib/session.ts).
  const session = sessionFromRequest(req);
  if (!session) {
    return json({ error: "Log in to deposit." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  (body as Record<string, unknown>).ign = session.ign;
  const parsed = parseDepositRequest(body);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });

  const block = depositBlock(getDb(), parsed.server);
  if (block) return json({ error: blockMessage(parsed.server, "deposit", block) }, { status: 403 });

  // Which pool the deposit is headed for — the UI's active tab. Only a
  // matching-pool bot may claim it (seasonal chars trade seasonal players),
  // and the game drops trade requests across the split, so a guessed side
  // means a bot that can never reach the player: it must be said.
  // A communism deposit goes to a communism account of that same half.
  const side = (body as Record<string, unknown>)?.seasonal;
  if (typeof side !== "boolean") {
    return json({ error: "Say which side the character is on: seasonal true or false." }, { status: 400 });
  }
  const seasonal: 0 | 1 = side ? 1 : 0;

  const created = await createDepositRequest(getDb(), {
    ign: parsed.ign,
    ignLower: parsed.ignLower,
    server: parsed.server,
    slots: parsed.slots,
    seasonal,
    items: parsed.items,
    communism: parsed.communism,
  });
  if (!created.ok) {
    return json(
      // hasOpen lets the UI offer a one-click cancel of the wedged request
      // instead of just printing the message.
      { error: created.error, ...(created.hasOpen ? { hasOpen: true } : {}) },
      { status: created.status },
    );
  }

  return json({
    ok: true,
    groupId: created.groupId,
    tradeCount: 1,
    requestId: created.requestId,
  });
}
