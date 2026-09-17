// Numbered, append-only schema migrations. Each runs once, in order, and is
// recorded in schema_migrations. The legacy bootstrap in db.ts still creates
// the base tables idempotently; everything after it goes here.
import type Database from "better-sqlite3";

export interface Migration {
  id: number;
  name: string;
  up(db: Database.Database): void;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "request_events",
    up(db) {
      db.exec(`
        -- Append-only audit of every request transition. One row per event:
        -- created, claimed, fulfilled, unclaimed, cancelled, expired. Detail
        -- is free-form JSON (items delivered, why it was cancelled, ...).
        CREATE TABLE IF NOT EXISTS request_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK (kind IN ('deposit','withdraw')),
          request_id INTEGER NOT NULL,
          event TEXT NOT NULL,
          bot_guid TEXT,
          detail TEXT,
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_req_events_req ON request_events(kind, request_id, id);
        CREATE INDEX IF NOT EXISTS idx_req_events_at ON request_events(at);
      `);
    },
  },
  {
    id: 2,
    name: "drop_bot_protocol",
    up(db) {
      // Bot presence now lives in memory (lib/fleetPresence.ts), fed by the
      // in-process fleet; the signed HTTP protocol and its replay guard are
      // gone with it.
      db.exec(`
        DROP TABLE IF EXISTS bots;
        DROP TABLE IF EXISTS fulfill_nonces;
        DELETE FROM schema_meta WHERE key IN ('pool_size', 'pool_size_updated_at');
      `);
    },
  },
  {
    id: 3,
    name: "users_and_personal_storage",
    up(db) {
      db.exec(`
        -- A player account. Sessions are still minted per IGN (the in-game
        -- /tell proves control of one character at a time), but several IGNs
        -- can hang off one user so a player with alts sees one vault and one
        -- set of settings. The first login from an IGN nobody has linked
        -- creates its user on the spot.
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          -- Personal storage: which pool half the slots are allocated in
          -- (1 seasonal, 0 non-seasonal). Switching needs an empty vault:
          -- a seasonal bot cannot trade a non-seasonal one.
          vault_seasonal INTEGER NOT NULL DEFAULT 1,
          -- Entitlement, per player rather than a constant so it can be
          -- raised later.
          vault_slots INTEGER NOT NULL DEFAULT 8,
          -- The bot dedicated to this user's items while they hold any;
          -- released (NULL) once the vault is empty again.
          vault_bot_guid TEXT UNIQUE,
          vault_bot_since INTEGER
        );
        CREATE TABLE IF NOT EXISTS user_igns (
          ign_lower TEXT PRIMARY KEY,
          ign TEXT NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          linked_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_igns_user ON user_igns(user_id);

        -- Who owns which physical item. THE source of truth for personal
        -- storage: the pool is every tracked instance not listed here, and
        -- the fleet mirrors this table when it packs items onto vault bots.
        CREATE TABLE IF NOT EXISTS vault_items (
          instance_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          item_id TEXT NOT NULL,
          enchants INTEGER NOT NULL DEFAULT 0,
          seasonal INTEGER NOT NULL,
          -- The bot the tracker last reported holding it. Items claimed from
          -- the pool start on whatever bot had them and are moved to the
          -- owner's vault bot by the fleet.
          bot_guid TEXT,
          source TEXT NOT NULL CHECK (source IN ('claim','deposit')),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vault_items_user ON vault_items(user_id);
        CREATE INDEX IF NOT EXISTS idx_vault_items_bot ON vault_items(bot_guid);

        -- Append-only audit of personal storage: claimed, donated, deposited,
        -- withdrawn, moved, lost.
        CREATE TABLE IF NOT EXISTS vault_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          ign TEXT NOT NULL,
          event TEXT NOT NULL,
          instance_id TEXT,
          item_id TEXT,
          detail TEXT,
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vault_events_user ON vault_events(user_id, id);

        -- A request into or out of personal storage names its user; NULL is
        -- an ordinary pool request. Only the user's vault bot may claim a
        -- vault deposit, and neither kind touches the points ledger.
        ALTER TABLE deposit_requests ADD COLUMN vault_user_id INTEGER;
        ALTER TABLE withdraw_requests ADD COLUMN vault_user_id INTEGER;
      `);
    },
  },
  {
    id: 4,
    name: "wishlist",
    up(db) {
      db.exec(`
        -- Per-IGN switches for features the operator hands out from the dev
        -- console (lib/features.ts). A user has a feature when any of their
        -- linked characters holds the grant.
        CREATE TABLE IF NOT EXISTS feature_grants (
          ign_lower TEXT NOT NULL,
          feature TEXT NOT NULL,
          ign TEXT NOT NULL,
          granted_at INTEGER NOT NULL,
          PRIMARY KEY (ign_lower, feature)
        );

        -- Standing claims: "when an item like this reaches the pool, put it
        -- in my vault". One row per rule; match_json is the enchant spec in
        -- disjunctive normal form (lib/wishlist.ts). slots_exact NULL means
        -- "at least slots_min" enchantments.
        CREATE TABLE IF NOT EXISTS wishlist_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          item_id TEXT NOT NULL,
          slots_min INTEGER NOT NULL DEFAULT 0,
          slots_exact INTEGER,
          match_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          hits INTEGER NOT NULL DEFAULT 0,
          last_hit_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wishlist_rules_user ON wishlist_rules(user_id, id);
      `);
    },
  },
  {
    id: 5,
    name: "vault_halves",
    up(db) {
      db.exec(`
        -- Personal storage is two vaults per account, one in each pool half,
        -- each on a bot of its own: a seasonal bot cannot trade a
        -- non-seasonal player. users.vault_slots stays the account's total
        -- entitlement; this table says how many of those slots each half
        -- holds (allocated in blocks of VAULT_BLOCK, lib/vault.ts) and which
        -- bot is dedicated to it while it holds anything.
        CREATE TABLE IF NOT EXISTS vault_halves (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          seasonal INTEGER NOT NULL,
          slots INTEGER NOT NULL DEFAULT 0,
          bot_guid TEXT UNIQUE,
          bot_since INTEGER,
          PRIMARY KEY (user_id, seasonal)
        );
        -- Every existing vault keeps its slots, bot and items in the half it
        -- was allocated to; the other half starts empty.
        INSERT INTO vault_halves (user_id, seasonal, slots, bot_guid, bot_since)
          SELECT id, CASE WHEN vault_seasonal <> 0 THEN 1 ELSE 0 END, vault_slots, vault_bot_guid, vault_bot_since FROM users;
        INSERT INTO vault_halves (user_id, seasonal, slots)
          SELECT id, CASE WHEN vault_seasonal <> 0 THEN 0 ELSE 1 END, 0 FROM users;
        -- A wish names its pool half; existing wishes were made against the
        -- half the vault was allocated to.
        ALTER TABLE wishlist_rules ADD COLUMN seasonal INTEGER NOT NULL DEFAULT 1;
        UPDATE wishlist_rules SET seasonal = (SELECT CASE WHEN u.vault_seasonal <> 0 THEN 1 ELSE 0 END FROM users u WHERE u.id = wishlist_rules.user_id);
        -- users.vault_bot_guid is UNIQUE and so cannot be dropped; it stays
        -- as an unused, always-NULL column. The other two go.
        UPDATE users SET vault_bot_guid = NULL;
        ALTER TABLE users DROP COLUMN vault_seasonal;
        ALTER TABLE users DROP COLUMN vault_bot_since;
      `);
    },
  },
  {
    // 6: a bot may back more than one vault half. On a node with a handful
    // of accounts, guests' vaults share the owner's bots (design doc §6.5),
    // so the dedicated-bot rule from the shared pool goes. SQLite cannot
    // drop a UNIQUE from a column, so the table is rebuilt without it.
    id: 6,
    name: "shared_vault_bots",
    up(db) {
      db.exec(`
        CREATE TABLE vault_halves_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          seasonal INTEGER NOT NULL,
          slots INTEGER NOT NULL DEFAULT 0,
          bot_guid TEXT,
          bot_since INTEGER,
          PRIMARY KEY (user_id, seasonal)
        );
        INSERT INTO vault_halves_new (user_id, seasonal, slots, bot_guid, bot_since)
          SELECT user_id, seasonal, slots, bot_guid, bot_since FROM vault_halves;
        DROP TABLE vault_halves;
        ALTER TABLE vault_halves_new RENAME TO vault_halves;
        CREATE INDEX IF NOT EXISTS vault_halves_bot ON vault_halves (bot_guid);
      `);
    },
  },
];

export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id));
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
    })();
    console.log(`[db.migrate] applied ${m.id} ${m.name}`);
    ran.push(m.id);
  }
  return ran;
}
