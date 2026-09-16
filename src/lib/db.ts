import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { CATALOG } from "./catalog";
import { runMigrations } from "./migrations";

// DATA_DIR holds the SQLite file. On Railway this MUST be a persistent
// volume mount (Settings → Volumes), otherwise the DB is wiped on every
// container restart — bots' instance sync, bots table, and the legacy
// purge flag all reset, so the pool looks empty until pyrelay's next
// startup sweep, and even then desyncs the moment the website restarts
// again. Override with DATA_DIR=/some/volume/path; default keeps the
// previous behavior for local dev where the cwd is the repo root.
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "pool.db");

declare global {
  // eslint-disable-next-line no-var
  var __pool_db__: Database.Database | undefined;
}

const SCHEMA_VERSION = 8;

function init(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pool (
      item_id TEXT PRIMARY KEY,
      qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('deposit','withdraw')),
      ign TEXT NOT NULL,
      ign_lower TEXT NOT NULL DEFAULT '',
      item_id TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      server TEXT,
      request_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_ign_lower ON transactions(ign_lower);

    CREATE TABLE IF NOT EXISTS deposit_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ign TEXT NOT NULL,
      ign_lower TEXT NOT NULL DEFAULT '',
      server TEXT NOT NULL,
      -- item_count is the size of the deposit's one trade: only a bot with
      -- that many free slots claims it (the site asks for 8 or 16, the API
      -- 1-16). It used to be a declared upper bound drained across chained
      -- trades; remaining_count and current_cap survive from then.
      item_count INTEGER NOT NULL DEFAULT 1
        CHECK (item_count BETWEEN 1 AND 64),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','claimed','fulfilled','cancelled')),
      claimed_by TEXT,
      group_id TEXT,
      target_bot_guid TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_req_status ON deposit_requests(status, created_at DESC);
    -- idx_dreq_group is created below, after the additive migration that
    -- adds the group_id column on older DBs. Putting it here would fail
    -- the whole bootstrap block on a pre-migration DB.

    -- (bots, bot_inventory and fulfill_nonces used to be created here; bot
    -- presence is in memory now — see lib/fleetPresence.ts — and migration 2
    -- drops the tables on databases that still have them.)

    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ign TEXT NOT NULL,
      ign_lower TEXT NOT NULL,
      server TEXT NOT NULL,
      items_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','claimed','fulfilled','cancelled','failed')),
      claimed_by TEXT,
      group_id TEXT,
      target_bot_guid TEXT,
      -- JSON array of instance_ids the user picked. NULL = legacy aggregate
      -- withdraw (target_bot_guid is a routing hint). Non-null = the user
      -- chose specific physical items; target_bot_guid becomes a hard claim
      -- gate and the fulfilling bot must still hold each named instance.
      instance_ids_json TEXT,
      -- Which pool the player withdrew from (the tab they had selected). A
      -- seasonal character can only trade a seasonal bot, so only a bot of
      -- this type may claim the row.
      seasonal INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wreq_status ON withdraw_requests(status, created_at DESC);
    -- idx_wreq_ign_lower and idx_wreq_group are created below for the
    -- same reason as idx_dreq_group: the columns may be added by the
    -- additive migration that runs after this block.

    -- Operator-imposed per-player withdraw caps (see lib/playerLimits.ts).
    -- One row per IGN: at most items_per_day items withdrawn per rolling
    -- 24h window, enforced until expires_at. Expired rows are ignored by
    -- the withdraw path and pruned when the operator console lists them.
    CREATE TABLE IF NOT EXISTS player_rate_limits (
      ign_lower TEXT PRIMARY KEY,
      ign TEXT NOT NULL,
      items_per_day INTEGER NOT NULL CHECK (items_per_day >= 1),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Leaderboard disqualifications (see lib/leaderboardDq.ts). A row means
    -- "this IGN is not shown on the boards and holds no rank" — a moderation
    -- decision, not a scoring one. The ledger is untouched: their points are
    -- still computed and still shown on their own profile, they just stop
    -- being ranked against everyone else. Removing the row restores them.
    CREATE TABLE IF NOT EXISTS leaderboard_dq (
      ign_lower TEXT PRIMARY KEY,
      ign TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    -- Operator-published item prices (see lib/itemPricing.ts). One row per
    -- PUBLISH, not per item: re-pricing is a batch, and the batch's
    -- effective_at is the cutoff that keeps it off everyone's history. A
    -- transaction scores by the last epoch whose effective_at is <= its
    -- created_at, exactly like the five hardcoded epochs in lib/leaderboard.ts
    -- that these extend.
    --
    -- Append-only by design. Editing an epoch in place would silently
    -- re-score every deposit made since it shipped, which is the one thing
    -- the whole epoch mechanism exists to prevent.
    CREATE TABLE IF NOT EXISTS pricing_epochs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      effective_at INTEGER NOT NULL UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    -- The prices one epoch sets. Sparse: an item absent from an epoch keeps
    -- whatever the previous epoch (or the hardcoded tables) gave it, so a
    -- publish that changes three items stores three rows.
    CREATE TABLE IF NOT EXISTS pricing_prices (
      epoch_id INTEGER NOT NULL REFERENCES pricing_epochs(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      points REAL NOT NULL CHECK (points >= 0),
      PRIMARY KEY (epoch_id, item_id)
    );

    -- Per-server deposit/withdraw kill switches (see lib/serverControls.ts).
    -- A row means "this server has deposits and/or withdraws disabled."
    -- Absent row = both enabled (the default). Operator-only, toggled from
    -- the dev console's Server Controls tab.
    CREATE TABLE IF NOT EXISTS server_controls (
      server TEXT PRIMARY KEY,
      deposits_disabled INTEGER NOT NULL DEFAULT 0 CHECK (deposits_disabled IN (0, 1)),
      withdraws_disabled INTEGER NOT NULL DEFAULT 0 CHECK (withdraws_disabled IN (0, 1)),
      updated_at INTEGER NOT NULL
    );

    -- Items the pool no longer accepts. Present tense, NOT epoch-scoped:
    -- "do we take this today" is a question about now, and re-asking it of a
    -- year-old deposit would mean nothing. Delisting hides an item from the
    -- deposit grid and refuses new deposit claims for it; anything already in
    -- the pool stays withdrawable, or it would be stranded on a bot forever.
    CREATE TABLE IF NOT EXISTS item_delistings (
      item_id TEXT PRIMARY KEY,
      delisted_at INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );

    -- Blog posts, written and edited from the operator console. The body is
    -- the same small markdown the Blog component renders. Posts that used to
    -- live as files in content/blog are imported once (lib/blog.ts) and the
    -- database is the source of truth from then on; a draft (published = 0)
    -- is visible only behind the dev password.
    CREATE TABLE IF NOT EXISTS blog_posts (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blog_date ON blog_posts(published, date DESC);
  `);

  // Additive migrations for older DBs
  const txCols = db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[];
  if (!txCols.some((c) => c.name === "server")) {
    db.exec("ALTER TABLE transactions ADD COLUMN server TEXT");
  }
  if (!txCols.some((c) => c.name === "request_id")) {
    db.exec("ALTER TABLE transactions ADD COLUMN request_id INTEGER");
  }
  if (!txCols.some((c) => c.name === "ign_lower")) {
    db.exec("ALTER TABLE transactions ADD COLUMN ign_lower TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE transactions SET ign_lower = lower(ign) WHERE ign_lower = ''");
  }
  // Enchantment count of the traded item(s) — rows split by it, so a trade
  // delivering one clean and one 2-enchant Doom Bow writes two rows. Feeds
  // the epoch-3 enchant scoring multiplier. Rows from before the column
  // (and any path that can't know, e.g. legacy aggregate withdraws) are 0.
  if (!txCols.some((c) => c.name === "enchants")) {
    console.log("[db.init] adding transactions.enchants");
    db.exec("ALTER TABLE transactions ADD COLUMN enchants INTEGER NOT NULL DEFAULT 0");
  }

  const reqCols = db.prepare("PRAGMA table_info(deposit_requests)").all() as { name: string }[];
  if (!reqCols.some((c) => c.name === "item_count")) {
    db.exec("ALTER TABLE deposit_requests ADD COLUMN item_count INTEGER NOT NULL DEFAULT 1");
  }
  if (!reqCols.some((c) => c.name === "ign_lower")) {
    db.exec("ALTER TABLE deposit_requests ADD COLUMN ign_lower TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE deposit_requests SET ign_lower = lower(ign) WHERE ign_lower = ''");
  }
  if (!reqCols.some((c) => c.name === "group_id")) {
    console.log("[db.init] adding deposit_requests.group_id");
    db.exec("ALTER TABLE deposit_requests ADD COLUMN group_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_dreq_group ON deposit_requests(group_id)");
  }
  if (!reqCols.some((c) => c.name === "target_bot_guid")) {
    console.log("[db.init] adding deposit_requests.target_bot_guid");
    db.exec("ALTER TABLE deposit_requests ADD COLUMN target_bot_guid TEXT");
  }
  // remaining_count: how many declared items still need a bot. Starts equal
  // to item_count; decremented by each fulfill. When a bot completes a slice
  // smaller than the trade cap (player accepted early), remaining drops to 0
  // and the row terminally moves to 'fulfilled'. Otherwise the row swings
  // back to 'pending' so the next bot can pick up the rest.
  if (!reqCols.some((c) => c.name === "remaining_count")) {
    console.log("[db.init] adding deposit_requests.remaining_count");
    db.exec("ALTER TABLE deposit_requests ADD COLUMN remaining_count INTEGER");
    // Backfill: an open row still has all its items outstanding; terminal
    // rows are done so remaining is 0 (kept aligned for any future analytics).
    db.exec(
      "UPDATE deposit_requests SET remaining_count = CASE " +
      "WHEN status IN ('pending','claimed') THEN item_count ELSE 0 END " +
      "WHERE remaining_count IS NULL",
    );
  }
  // current_cap: the per-trade cap the active claimant agreed to. Set at
  // claim time to min(remaining_count, bot.free_slots) and cleared at
  // fulfill. fulfill uses it to tell "player accepted with K = cap, expect
  // more" apart from "player accepted with K < cap, deposit is done".
  if (!reqCols.some((c) => c.name === "current_cap")) {
    console.log("[db.init] adding deposit_requests.current_cap");
    db.exec("ALTER TABLE deposit_requests ADD COLUMN current_cap INTEGER");
  }
  // The original schema CHECK was BETWEEN 1 AND 8 — we now allow up to 64
  // since the deposit form no longer shows a count picker and the request
  // declares the upper bound of "could deposit up to N items via multi-bot
  // continuation." SQLite can't ALTER a CHECK constraint, so on an existing
  // DB we rebuild the table when the constraint string still matches the
  // old shape. The sql column on sqlite_master is the exact CREATE text;
  // we look for "BETWEEN 1 AND 8" to detect the legacy shape.
  const reqTblSql = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deposit_requests'")
      .get() as { sql: string } | undefined
  )?.sql;
  if (reqTblSql && /item_count\s+INTEGER[^,]*BETWEEN\s+1\s+AND\s+8/i.test(reqTblSql)) {
    console.log("[db.init] rebuilding deposit_requests to relax item_count CHECK 1..8 -> 1..64");
    db.exec(`
      CREATE TABLE deposit_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ign TEXT NOT NULL,
        ign_lower TEXT NOT NULL DEFAULT '',
        server TEXT NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 1
          CHECK (item_count BETWEEN 1 AND 64),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','claimed','fulfilled','cancelled')),
        claimed_by TEXT,
        group_id TEXT,
        target_bot_guid TEXT,
        remaining_count INTEGER,
        current_cap INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO deposit_requests_new
        (id, ign, ign_lower, server, item_count, status, claimed_by, group_id,
         target_bot_guid, remaining_count, current_cap, created_at, updated_at)
      SELECT
        id, ign, ign_lower, server, item_count, status, claimed_by, group_id,
        target_bot_guid, remaining_count, current_cap, created_at, updated_at
      FROM deposit_requests;
      DROP TABLE deposit_requests;
      ALTER TABLE deposit_requests_new RENAME TO deposit_requests;
      CREATE INDEX IF NOT EXISTS idx_req_status ON deposit_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dreq_group ON deposit_requests(group_id);
    `);
  }

  // end_reason: why an open-ended deposit stopped, when it ended some way
  // other than the player simply under-filling a trade. Currently only
  // 'vault-full' (no bot in the pool has a free slot left, so there is
  // nothing more to chain to) — NULL on every normal ending. The vault page
  // reads it so "deposit complete" can say which of the two happened.
  //
  // Added AFTER the rebuild above, and re-reading the column list, because
  // the rebuild recreates the table from a fixed column list and would drop
  // anything an earlier ALTER had added.
  const reqCols2 = db.prepare("PRAGMA table_info(deposit_requests)").all() as { name: string }[];
  if (!reqCols2.some((c) => c.name === "end_reason")) {
    console.log("[db.init] adding deposit_requests.end_reason");
    db.exec("ALTER TABLE deposit_requests ADD COLUMN end_reason TEXT");
  }
  // items_json: what the depositor said they are bringing ([{itemId, qty}]),
  // or NULL when they didn't say. A hint, not a contract — the trade takes
  // whatever the player actually puts up. The fleet uses it to send the
  // deposit to the bot already gathering that kind of potion, so the items
  // don't have to be moved again later.
  if (!reqCols2.some((c) => c.name === "items_json")) {
    console.log("[db.init] adding deposit_requests.items_json");
    db.exec("ALTER TABLE deposit_requests ADD COLUMN items_json TEXT");
  }

  const wreqCols = db.prepare("PRAGMA table_info(withdraw_requests)").all() as { name: string }[];
  if (wreqCols.length > 0) {
    console.log(`[db.init] withdraw_requests columns: ${wreqCols.map((c) => c.name).join(", ")}`);
  }
  if (wreqCols.length > 0 && !wreqCols.some((c) => c.name === "ign_lower")) {
    console.log("[db.init] adding withdraw_requests.ign_lower");
    db.exec("ALTER TABLE withdraw_requests ADD COLUMN ign_lower TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE withdraw_requests SET ign_lower = lower(ign) WHERE ign_lower = ''");
  }
  if (wreqCols.length > 0 && !wreqCols.some((c) => c.name === "group_id")) {
    console.log("[db.init] adding withdraw_requests.group_id");
    db.exec("ALTER TABLE withdraw_requests ADD COLUMN group_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wreq_group ON withdraw_requests(group_id)");
  }
  if (wreqCols.length > 0 && !wreqCols.some((c) => c.name === "target_bot_guid")) {
    console.log("[db.init] adding withdraw_requests.target_bot_guid");
    db.exec("ALTER TABLE withdraw_requests ADD COLUMN target_bot_guid TEXT");
  }
  if (wreqCols.length > 0 && !wreqCols.some((c) => c.name === "instance_ids_json")) {
    console.log("[db.init] adding withdraw_requests.instance_ids_json");
    db.exec("ALTER TABLE withdraw_requests ADD COLUMN instance_ids_json TEXT");
  }

  // Seasonal / non-seasonal pool split: bots carry which pool they serve
  // (from the dispatcher heartbeat) and deposit requests carry which pool
  // the player picked, so claim-matching can pair like with like. Default 1
  // (seasonal) — that's the only type the pipeline produced before the split.
  const dreqSeasonalCols = db.prepare("PRAGMA table_info(deposit_requests)").all() as { name: string }[];
  if (dreqSeasonalCols.length > 0 && !dreqSeasonalCols.some((c) => c.name === "seasonal")) {
    console.log("[db.init] adding deposit_requests.seasonal");
    db.exec("ALTER TABLE deposit_requests ADD COLUMN seasonal INTEGER NOT NULL DEFAULT 1");
  }
  // Withdraws are pool-scoped for the same reason deposits are: the player
  // withdrawing is on one character, and only a bot of that character's type
  // can meet them. Backfilling the existing rows to 1 matches the pre-split
  // default every other seasonal column uses.
  if (wreqCols.length > 0 && !wreqCols.some((c) => c.name === "seasonal")) {
    console.log("[db.init] adding withdraw_requests.seasonal");
    db.exec("ALTER TABLE withdraw_requests ADD COLUMN seasonal INTEGER NOT NULL DEFAULT 1");
  }

  // bot_inventory_instances was a short-lived design: pyrelay used to push
  // its per-physical-item view here so the website could project it. The
  // website now reads pyrelay's /pool live on every request instead, so
  // this table holds no data anyone reads. Drop it if it exists.
  db.exec("DROP TABLE IF EXISTS bot_inventory_instances");

  // Ensure indexes on migrated columns exist. We can only create these once
  // the additive migrations above have guaranteed the columns are present —
  // putting them in the bootstrap CREATE TABLE block would fail the whole
  // block on an older DB where the column doesn't exist yet.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_dreq_group ON deposit_requests(group_id);" +
    "CREATE INDEX IF NOT EXISTS idx_wreq_ign_lower ON withdraw_requests(ign_lower);" +
    "CREATE INDEX IF NOT EXISTS idx_wreq_group ON withdraw_requests(group_id);" +
    // /api/deposit sums deposited-so-far per open request straight from the
    // ledger (see the committedSlots subquery), which without this index is
    // a full transactions scan per open row on every deposit submit.
    "CREATE INDEX IF NOT EXISTS idx_tx_request ON transactions(kind, request_id);"
  );

  // One-shot purge of the pre-instance quantity ledgers. The pool view is
  // now exclusively driven by bot_inventory_instances, populated by pyrelay
  // via /api/bot/sync-instances. The old `pool` and `bot_inventory` tables
  // accumulated years of stale aggregate data that the website used to
  // surface as "legacy stock" tiles — those have been removed from the UI,
  // so the rows themselves should go too. Keyed by a meta flag so it only
  // runs once per database.
  const purged = (
    db
      .prepare("SELECT value FROM schema_meta WHERE key = 'legacy_qty_purged'")
      .get() as { value: string } | undefined
  )?.value;
  if (purged !== "1") {
    console.log("[db.init] purging legacy bot_inventory + pool qty rows");
    db.exec("DELETE FROM pool;");
    db.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('legacy_qty_purged', '1')",
    ).run();
  }

  db.prepare(
    "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
  ).run(String(SCHEMA_VERSION));

  const seed = db.prepare("INSERT OR IGNORE INTO pool (item_id, qty) VALUES (?, 0)");
  const seedAll = db.transaction(() => {
    for (const item of CATALOG) seed.run(item.id);
  });
  seedAll();

  runMigrations(db);
}

/** Open (and bootstrap) a database at `file`. ":memory:" for tests. */
export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  init(db);
  return db;
}

export function getDb(): Database.Database {
  if (!globalThis.__pool_db__) globalThis.__pool_db__ = openDatabase(DB_PATH);
  return globalThis.__pool_db__;
}
