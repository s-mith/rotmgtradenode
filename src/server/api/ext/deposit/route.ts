import { MAX_TRADE_SLOTS } from "@/lib/depositSizes";
import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkApiKey } from "@/lib/apiKeys";
import { checkIgn, parseDeclaredItems } from "@/lib/validation";
import { SERVER_SET } from "@/lib/servers";
import { rateLimit } from "@/lib/ratelimit";
import { createDepositRequest } from "@/lib/depositRequest";
import { depositGroupStatus } from "@/lib/depositStatus";
import { blockMessage, depositBlock } from "@/lib/serverControls";

// POST /api/ext/deposit
//
// Queue a deposit on behalf of an automated client. This is the machine-facing
// twin of /api/deposit: same queue, same bots, same capacity accounting — the
// only difference is where the IGN comes from. The website takes it from the
// session cookie (proof of character control, minted by an in-game /tell); a
// script can't hold one, so it presents an API key from EXT_API_KEYS and names
// the IGN in the body. See lib/apiKeys.ts for why that's an acceptable trade
// for deposits specifically.
//
// Body: {
//   ign:       string   character to credit the items to (letters only)
//   server:    string   realm the caller's character is sitting in
//   slots?:    number   the one trade's size, 1-16: only a bot with that
//                       many free slots comes (8 = an empty bot, 16 = an
//                       empty bot with a backpack). Default 8, or 16 when
//                       `items` needs it. `itemCount` (the old declared
//                       upper bound) is still accepted and mapped to this.
//   items?:     [{itemId, qty}]  what the character is bringing — a routing
//                       hint so the deposit lands on the bot already
//                       gathering those potions; never enforced
//   seasonal?:  boolean which pool half to deposit into (default true)
//   wait?:      number  seconds to hold the response open waiting for a bot
//                       to be assigned; 0-120, default 30
// }
//
// Returns 202 with { groupId, requestId, status, botIgn, pollUrl }. botIgn is
// the empty bot dispatched to meet the caller's character — it's null if no
// bot was assigned within the wait window, in which case keep polling pollUrl
// (GET /api/ext/deposit/<groupId>) until it appears. An unclaimed request is
// cancelled automatically after PENDING_TIMEOUT_MS (10 minutes).

// Per-key budget: 20 deposits up front, refilling at 20/min. A deposit is one
// human-paced in-game trade chain, so this is generous for a legitimate
// integration and still stops a looping script from filling the queue with
// rows the pool has to time out one by one.
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_SEC = 20 / 60;

const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 120;
// How often we re-read the row while waiting. The dispatcher claims out of
// band (bots poll /api/bot/claim-deposit), so there's nothing to await on —
// only the row to watch.
const POLL_INTERVAL_MS = 1000;

export async function POST(req: Request) {
  const auth = checkApiKey(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  // Keyed by caller, not IP: these clients run from anywhere (and several may
  // share a host), and the key is the identity we actually issued.
  if (!rateLimit(`ext-deposit:${auth.caller.label}`, RATE_CAPACITY, RATE_REFILL_PER_SEC)) {
    return json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const i = checkIgn(body.ign);
  if (!i.ok) return json({ error: i.error }, { status: 400 });
  if (typeof body.server !== "string" || !SERVER_SET.has(body.server)) {
    return json(
      { error: "Unknown server", servers: [...SERVER_SET] },
      { status: 400 },
    );
  }
  const server = body.server;
  // The trade's size. A deposit is one trade: the bot that comes has at
  // least this many free slots, and whatever the character puts in the
  // window is deposited. The old `itemCount` upper bound maps onto it.
  const declared = parseDeclaredItems(body.items);
  if (!declared.ok) return json({ error: declared.error }, { status: 400 });
  const declaredTotal = declared.items?.reduce((a, it) => a + it.qty, 0);
  let slots: number;
  if (body.slots !== undefined && body.slots !== null) {
    slots = Number(body.slots);
    if (!Number.isInteger(slots) || slots < 1 || slots > MAX_TRADE_SLOTS) return json({ error: `slots must be 1-${MAX_TRADE_SLOTS}` }, { status: 400 });
  } else if (body.itemCount !== undefined && body.itemCount !== null) {
    const n = Number(body.itemCount);
    if (!Number.isInteger(n) || n < 1 || n > 64) return json({ error: "itemCount must be 1-64" }, { status: 400 });
    slots = Math.min(MAX_TRADE_SLOTS, n);
  } else {
    slots = (declaredTotal ?? 0) > 8 ? 16 : 8;
  }
  // Defaults to seasonal, matching the website's deposit tab. A seasonal
  // character can only trade a seasonal bot, so getting this wrong means no
  // bot can ever claim the row and it ages out at the pending timeout.
  const seasonal: 0 | 1 = body.seasonal === undefined ? 1 : body.seasonal ? 1 : 0;
  const rawWait = body.wait;
  const waitS = rawWait === undefined || rawWait === null ? DEFAULT_WAIT_S : Number(rawWait);
  if (!Number.isFinite(waitS) || waitS < 0 || waitS > MAX_WAIT_S) {
    return json({ error: `wait must be 0-${MAX_WAIT_S} seconds` }, { status: 400 });
  }

  const db = getDb();

  const block = depositBlock(db, server);
  if (block) return json({ error: blockMessage(server, "deposit", block) }, { status: 403 });

  const created = await createDepositRequest(db, {
    ign: i.ign,
    ignLower: i.ignLower,
    server,
    slots,
    seasonal,
    items: declared.items,
  });
  if (!created.ok) {
    return json(
      { error: created.error, ...(created.hasOpen ? { hasOpen: true } : {}) },
      { status: created.status },
    );
  }

  const pollUrl = `/api/ext/deposit/${created.groupId}`;
  const deadline = Date.now() + waitS * 1000;
  let status = await depositGroupStatus(db, created.groupId);
  // Hold the response open until a bot is assigned, so the common case is one
  // call that answers "trade this character". Bail early if the request stops
  // being in flight (cancelled out from under us, or — impossibly fast — done).
  while (
    status &&
    !status.trades.some((t) => t.botIgn) &&
    status.groupStatus === "in-flight" &&
    Date.now() < deadline
  ) {
    // req.signal aborts when the caller hangs up; stop burning polls on a
    // response nobody will read.
    if (req.signal.aborted) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    status = await depositGroupStatus(db, created.groupId);
  }

  const botIgn = status?.trades.find((t) => t.botIgn)?.botIgn ?? null;
  return json(
    {
      ok: true,
      groupId: created.groupId,
      requestId: created.requestId,
      ign: i.ign,
      server,
      seasonal: Boolean(seasonal),
      slots,
      // The old name, for callers written against it.
      itemCount: slots,
      ...(declared.items ? { items: declared.items } : {}),
      // "waiting" = queued, no bot yet — poll. "assigned" = botIgn is the bot
      // to trade. Terminal states can only show up here if the caller waited
      // long enough for the whole thing to resolve.
      status: botIgn ? "assigned" : status?.groupStatus === "in-flight" ? "waiting" : (status?.groupStatus ?? "waiting"),
      botIgn,
      pollUrl,
    },
    { status: 202 },
  );
}
