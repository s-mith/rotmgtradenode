// Operator-published item prices and delistings — the data-driven half of the
// scoring rules in lib/leaderboard.ts.
//
// Epochs 1-5 are hardcoded there because they predate this console and their
// tables are the historical record; nothing here can move them. Everything
// after is published from /dev/settings → Item points, and lands in
// pricing_epochs + pricing_prices.
//
// THE CUTOFF IS THE POINT. Publishing does not edit the current prices, it
// APPENDS a new epoch stamped with the moment you pressed save. Deposits and
// withdraws before that moment keep scoring by the table that was in force
// when they happened, so a re-price can never move anyone's total — the same
// guarantee the hardcoded epochs give, extended to prices you set at runtime.
// That is also why a publish is a batch: everything you change in one sitting
// shares one cutoff instead of scattering near-identical epochs across a
// minute of clicking.
//
// Delistings are deliberately NOT epoch-scoped. "Does the pool accept this
// item today" is a present-tense question, and re-asking it of a year-old
// deposit would be meaningless. A delisted item disappears from the deposit
// grid and its deposit claims are refused; whatever is already in the pool
// stays withdrawable, because the alternative is stranding it on a bot.

import type Database from "better-sqlite3";
import { getDb } from "./db";
import { ITEM_BY_ID } from "./catalog";

export type PricingEpoch = {
  id: number;
  /** Cutoff: transactions at or after this score by this epoch's table. */
  effectiveAt: number;
  note: string;
  createdAt: number;
  /** itemId -> points. Sparse — absent items inherit the previous epoch. */
  prices: Record<string, number>;
};

export type Delisting = {
  itemId: string;
  itemName: string;
  delistedAt: number;
  note: string;
};

/**
 * Everything scoring needs, in one immutable object.
 *
 * `cutoffs` and `tables` are parallel arrays ordered oldest-first, holding
 * ONLY the operator-published epochs. leaderboard.ts layers them over its own
 * five, so index 0 here is epoch 6 there.
 */
export type PricingSnapshot = {
  cutoffs: number[];
  tables: Map<string, number>[];
  delisted: Set<string>;
};

const EMPTY: PricingSnapshot = { cutoffs: [], tables: [], delisted: new Set() };

// pointsAt() is a hot, synchronous call — every board, profile and pool
// projection runs it per row — so it reads this cache rather than the DB.
// Invalidated explicitly on write (single process owns the DB) and by a short
// TTL as a backstop, so a direct sqlite edit still takes effect on its own.
const TTL_MS = 5_000;
let cached: { at: number; snap: PricingSnapshot } | null = null;

/** Drop the cache. Called by every write below. */
export function invalidatePricing(): void {
  cached = null;
}

function readSnapshot(db: Database.Database): PricingSnapshot {
  const epochs = db
    .prepare("SELECT id, effective_at FROM pricing_epochs ORDER BY effective_at ASC")
    .all() as { id: number; effective_at: number }[];
  if (epochs.length === 0) {
    return {
      cutoffs: [],
      tables: [],
      delisted: readDelistedSet(db),
    };
  }
  const priceRows = db
    .prepare("SELECT epoch_id, item_id, points FROM pricing_prices")
    .all() as { epoch_id: number; item_id: string; points: number }[];
  const byEpoch = new Map<number, Map<string, number>>();
  for (const e of epochs) byEpoch.set(e.id, new Map());
  for (const r of priceRows) byEpoch.get(r.epoch_id)?.set(r.item_id, r.points);
  return {
    cutoffs: epochs.map((e) => e.effective_at),
    tables: epochs.map((e) => byEpoch.get(e.id) ?? new Map()),
    delisted: readDelistedSet(db),
  };
}

function readDelistedSet(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT item_id FROM item_delistings").all() as {
    item_id: string;
  }[];
  return new Set(rows.map((r) => r.item_id));
}

/**
 * The current pricing rules. Safe to call per row.
 *
 * Never throws: a database that isn't reachable (or predates the tables)
 * yields the empty snapshot, which scores exactly like the hardcoded epochs
 * alone. Scoring falling back to "the rules as of the last deploy" is far
 * better than a board that 500s.
 */
export function pricingSnapshot(): PricingSnapshot {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.snap;
  let snap: PricingSnapshot;
  try {
    snap = readSnapshot(getDb());
  } catch (e) {
    console.error("[itemPricing] falling back to built-in prices:", e);
    snap = EMPTY;
  }
  cached = { at: now, snap };
  return snap;
}

/**
 * The operator-set price for `itemId` at `atMs`, or undefined when no
 * published epoch covers it (so the hardcoded tables decide).
 *
 * Walks newest-first and stops at the first epoch that both applies and names
 * the item — that's what makes a publish sparse: changing three items doesn't
 * have to restate the other six hundred.
 */
export function publishedPriceAt(
  itemId: string,
  atMs: number,
  snap: PricingSnapshot = pricingSnapshot(),
): number | undefined {
  for (let i = snap.cutoffs.length - 1; i >= 0; i--) {
    if (snap.cutoffs[i] > atMs) continue;
    const p = snap.tables[i].get(itemId);
    if (p !== undefined) return p;
  }
  return undefined;
}

/** Is this item currently accepted for deposit? */
export function isListed(itemId: string, snap: PricingSnapshot = pricingSnapshot()): boolean {
  return !snap.delisted.has(itemId);
}

// ---- operator reads --------------------------------------------------------

/** Every published epoch, newest first, with the prices it set. */
export function listEpochs(db: Database.Database): PricingEpoch[] {
  const epochs = db
    .prepare("SELECT * FROM pricing_epochs ORDER BY effective_at DESC")
    .all() as { id: number; effective_at: number; note: string; created_at: number }[];
  const priceRows = db
    .prepare("SELECT epoch_id, item_id, points FROM pricing_prices")
    .all() as { epoch_id: number; item_id: string; points: number }[];
  const byEpoch = new Map<number, Record<string, number>>();
  for (const r of priceRows) {
    (byEpoch.get(r.epoch_id) ?? byEpoch.set(r.epoch_id, {}).get(r.epoch_id)!)[r.item_id] =
      r.points;
  }
  return epochs.map((e) => ({
    id: e.id,
    effectiveAt: e.effective_at,
    note: e.note,
    createdAt: e.created_at,
    prices: byEpoch.get(e.id) ?? {},
  }));
}

/** Currently delisted items, newest first. */
export function listDelisted(db: Database.Database): Delisting[] {
  const rows = db
    .prepare("SELECT * FROM item_delistings ORDER BY delisted_at DESC")
    .all() as { item_id: string; delisted_at: number; note: string }[];
  return rows.map((r) => ({
    itemId: r.item_id,
    itemName: ITEM_BY_ID.get(r.item_id)?.name ?? r.item_id,
    delistedAt: r.delisted_at,
    note: r.note,
  }));
}

// ---- operator writes -------------------------------------------------------

export type PriceChange = { itemId: string; points: number };
export type ListingChange = { itemId: string; listed: boolean };

export type PublishResult = {
  /** null when the batch changed listings only — no epoch is minted for that. */
  epoch: PricingEpoch | null;
  /** Item ids this batch stopped accepting. */
  justDelisted: string[];
  /** Item ids this batch started accepting again. */
  justRelisted: string[];
};

/**
 * Apply one batch of operator changes.
 *
 * Price changes mint ONE new epoch stamped `Date.now()`; that timestamp is the
 * cutoff, so everything already in the ledger keeps its existing value. A
 * price identical to what the item already scores is dropped rather than
 * written — an epoch whose table restates the status quo is noise in the
 * history, and the console shows every epoch.
 *
 * Listing changes are applied in the same transaction but mint nothing: they
 * are current state, not a scoring rule. So a batch that only delists items
 * returns `epoch: null` and the ledger is untouched.
 */
export function publishChanges(
  db: Database.Database,
  changes: {
    prices: PriceChange[];
    listings: ListingChange[];
    note: string;
    /** Current price of each item, so no-op edits can be dropped. */
    currentPrice: (itemId: string) => number;
  },
): PublishResult {
  const now = Date.now();
  const real = changes.prices.filter((p) => p.points !== changes.currentPrice(p.itemId));

  let epochId: number | null = null;
  const justDelisted: string[] = [];
  const justRelisted: string[] = [];

  const run = db.transaction(() => {
    if (real.length > 0) {
      // effective_at is UNIQUE: two publishes inside the same millisecond
      // would collide, and the second's prices would land in the first's
      // epoch. Nudge forward instead — a millisecond of drift is invisible
      // and cannot reorder anything.
      let at = now;
      const taken = db.prepare("SELECT 1 FROM pricing_epochs WHERE effective_at = ?");
      while (taken.get(at)) at += 1;
      epochId = Number(
        db
          .prepare(
            "INSERT INTO pricing_epochs (effective_at, note, created_at) VALUES (?, ?, ?)",
          )
          .run(at, changes.note, now).lastInsertRowid,
      );
      const ins = db.prepare(
        "INSERT INTO pricing_prices (epoch_id, item_id, points) VALUES (?, ?, ?)",
      );
      for (const p of real) ins.run(epochId, p.itemId, p.points);
    }

    const del = db.prepare(
      `INSERT INTO item_delistings (item_id, delisted_at, note) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET note = excluded.note`,
    );
    const rel = db.prepare("DELETE FROM item_delistings WHERE item_id = ?");
    for (const l of changes.listings) {
      if (l.listed) {
        if (rel.run(l.itemId).changes > 0) justRelisted.push(l.itemId);
      } else {
        del.run(l.itemId, now, changes.note);
        justDelisted.push(l.itemId);
      }
    }
  });
  run();
  invalidatePricing();

  const epoch =
    epochId === null ? null : listEpochs(db).find((e) => e.id === epochId) ?? null;
  return { epoch, justDelisted, justRelisted };
}
