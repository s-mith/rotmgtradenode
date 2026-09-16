import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { CATALOG, ITEM_BY_ID } from "@/lib/catalog";
import { pointsAt } from "@/lib/leaderboard";
import {
  listDelisted,
  listEpochs,
  pricingSnapshot,
  publishChanges,
  type ListingChange,
  type PriceChange,
} from "@/lib/itemPricing";

// Operator console for item point values and pool listing.
//
// GET  /api/dev/item-pricing — every catalog item with the price it scores
//      right now and whether the pool still accepts it, plus the history of
//      published epochs.
// POST /api/dev/item-pricing — { prices?: [{itemId, points}], listings?:
//      [{itemId, listed}], note? } applies one BATCH.
//
// A batch is the unit on purpose. Price changes mint a single new epoch
// stamped with the moment of the request, and that timestamp is the cutoff:
// deposits and withdraws already in the ledger keep scoring by the table that
// was in force when they happened. Sending twelve items as twelve requests
// would scatter twelve near-identical cutoffs across a minute and make the
// history unreadable for no benefit — so the console collects edits and sends
// them together. See lib/itemPricing.ts for why delistings ride along without
// minting anything.
//
// Nothing here can edit an existing epoch. Re-pricing is always forward-only,
// which is the whole reason a player's total can't move under them.

const MAX_POINTS = 1000;
const MAX_NOTE = 200;
const MAX_BATCH = 2000;

function parsePrices(v: unknown): PriceChange[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return "prices must be an array";
  if (v.length > MAX_BATCH) return `prices: at most ${MAX_BATCH} entries`;
  const out: PriceChange[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return "Bad price entry";
    const itemId = (raw as { itemId?: unknown }).itemId;
    const points = Number((raw as { points?: unknown }).points);
    if (typeof itemId !== "string" || !ITEM_BY_ID.has(itemId))
      return `Unknown item: ${String(itemId)}`;
    if (seen.has(itemId)) return `Duplicate item in batch: ${itemId}`;
    seen.add(itemId);
    // Fractional prices are normal here — stat potions have scored 0.15 since
    // epoch 2 — but the ledger sums thousands of these, so they're pinned to
    // the same ten-thousandths grid roundPoints() uses. 0 is legal and means
    // "still accepted, worth nothing".
    if (!Number.isFinite(points) || points < 0 || points > MAX_POINTS)
      return `Points for ${itemId} must be between 0 and ${MAX_POINTS}`;
    if (Math.round(points * 10000) !== points * 10000)
      return `Points for ${itemId} can have at most 4 decimal places`;
    out.push({ itemId, points });
  }
  return out;
}

function parseListings(v: unknown): ListingChange[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return "listings must be an array";
  if (v.length > MAX_BATCH) return `listings: at most ${MAX_BATCH} entries`;
  const out: ListingChange[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return "Bad listing entry";
    const itemId = (raw as { itemId?: unknown }).itemId;
    if (typeof itemId !== "string" || !ITEM_BY_ID.has(itemId))
      return `Unknown item: ${String(itemId)}`;
    if (seen.has(itemId)) return `Duplicate item in batch: ${itemId}`;
    seen.add(itemId);
    out.push({ itemId, listed: Boolean((raw as { listed?: unknown }).listed) });
  }
  return out;
}

/** Every catalog item, with what it is worth and whether it's accepted. */
function itemRows() {
  const now = Date.now();
  const { delisted } = pricingSnapshot();
  return CATALOG.map((c) => ({
    itemId: c.id,
    itemName: c.name,
    category: c.category,
    subtype: c.subtype ?? null,
    points: pointsAt(c.id, now, 0),
    listed: !delisted.has(c.id),
  }));
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const db = getDb();
  return json({
    ok: true,
    items: itemRows(),
    epochs: listEpochs(db),
    delisted: listDelisted(db),
  });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const prices = parsePrices(body.prices);
  if (typeof prices === "string")
    return json({ error: prices }, { status: 400 });
  const listings = parseListings(body.listings);
  if (typeof listings === "string")
    return json({ error: listings }, { status: 400 });

  const noteRaw = body.note;
  if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== "string")
    return json({ error: "note must be text" }, { status: 400 });
  const note = (typeof noteRaw === "string" ? noteRaw : "").trim();
  if (note.length > MAX_NOTE)
    return json(
      { error: `Note must be ${MAX_NOTE} characters or fewer` },
      { status: 400 },
    );

  if (prices.length === 0 && listings.length === 0)
    return json({ error: "Nothing to publish" }, { status: 400 });

  const db = getDb();
  // The comparison baseline is read BEFORE the write and against the same
  // clock the new epoch will be stamped with, so "did this actually change?"
  // is answered against what the item scores today — not against whatever the
  // console was showing when the operator started typing.
  const now = Date.now();
  const result = publishChanges(db, {
    prices,
    listings,
    note,
    currentPrice: (itemId) => pointsAt(itemId, now, 0),
  });

  return json({
    ok: true,
    ...result,
    items: itemRows(),
    epochs: listEpochs(db),
    delisted: listDelisted(db),
  });
}
