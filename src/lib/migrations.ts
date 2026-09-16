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
          -- raised later (missions, points).
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
    // 6 is taken by the rotmg-trade branch.
    id: 7,
    name: "raids",
    up(db) {
      db.exec(`
        -- A dungeon raid (lib/raids.ts): a leader with keys, a stage, and the
        -- secrets handed out stage by stage. server and location are shown
        -- to a raider once they have joined the AFK check, party once the
        -- run is on; everyone else sees the server's region only.
        CREATE TABLE IF NOT EXISTS raids (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dungeon_id TEXT NOT NULL,
          leader_user_id INTEGER NOT NULL REFERENCES users(id),
          leader_ign TEXT NOT NULL,
          leader_ign_lower TEXT NOT NULL,
          server TEXT NOT NULL,
          location TEXT NOT NULL,
          party TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          keys INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK (status IN ('headcount','afk','running','ended')),
          -- While status = 'afk': when the check closes on its own.
          afk_ends_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ended_at INTEGER,
          -- Why it ended: leader, leader_left, timeout, operator.
          ended_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_raids_status ON raids(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_raids_leader ON raids(leader_user_id, status);

        -- Who is in a raid, under the name they joined as. The leader is a
        -- member of their own raid.
        CREATE TABLE IF NOT EXISTS raid_members (
          raid_id INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id),
          ign TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (raid_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_raid_members_user ON raid_members(user_id);

        -- Operator block: a name here can neither post nor join raids.
        CREATE TABLE IF NOT EXISTS raid_bans (
          ign_lower TEXT PRIMARY KEY,
          ign TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    id: 8,
    name: "raid_pops",
    up(db) {
      // The raids table is rebuilt: its status CHECK did not allow the new
      // "popping" stage (and is dropped — lib/raids.ts validates), and the
      // watcher / pop columns are added. raid_members is rebuilt alongside
      // so its foreign key follows the new table instead of cascading away
      // when the old one is dropped.
      db.exec(`
        CREATE TABLE raids_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dungeon_id TEXT NOT NULL,
          leader_user_id INTEGER NOT NULL REFERENCES users(id),
          leader_ign TEXT NOT NULL,
          leader_ign_lower TEXT NOT NULL,
          server TEXT NOT NULL,
          location TEXT NOT NULL,
          party TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          keys INTEGER NOT NULL DEFAULT 1,
          -- headcount, afk, popping, running, ended
          status TEXT NOT NULL,
          afk_ends_at INTEGER,
          -- While status = 'popping': when the pop window closes.
          pop_window_ends_at INTEGER,
          -- Confirmed pops so far (each key popped is one).
          pops_done INTEGER NOT NULL DEFAULT 0,
          -- The watcher bot's progress as last reported (lib/raidRules.ts WatcherState).
          watcher_state TEXT NOT NULL DEFAULT 'none',
          watcher_note TEXT NOT NULL DEFAULT '',
          watcher_bot TEXT,
          watcher_since INTEGER,
          -- Players the watcher last counted in the bazaar; NULL before it is inside.
          bazaar_count INTEGER,
          -- Raid members the watcher has seen in the bazaar: {ign_lower: {ign, at}}.
          present_json TEXT NOT NULL DEFAULT '{}',
          -- Extensions used on the current pop attempt.
          extended INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ended_at INTEGER,
          -- leader, leader_left, timeout, operator, no_pop
          ended_by TEXT
        );
        INSERT INTO raids_v2 (id, dungeon_id, leader_user_id, leader_ign, leader_ign_lower, server, location, party, description, keys, status, afk_ends_at, created_at, updated_at, ended_at, ended_by)
          SELECT id, dungeon_id, leader_user_id, leader_ign, leader_ign_lower, server, location, party, description, keys, status, afk_ends_at, created_at, updated_at, ended_at, ended_by FROM raids;
        CREATE TABLE raid_members_v2 (
          raid_id INTEGER NOT NULL REFERENCES raids_v2(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id),
          ign TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (raid_id, user_id)
        );
        INSERT INTO raid_members_v2 SELECT raid_id, user_id, ign, joined_at FROM raid_members;
        DROP TABLE raid_members;
        DROP TABLE raids;
        ALTER TABLE raids_v2 RENAME TO raids;
        ALTER TABLE raid_members_v2 RENAME TO raid_members;
        CREATE INDEX IF NOT EXISTS idx_raids_status ON raids(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_raids_leader ON raids(leader_user_id, status);
        CREATE INDEX IF NOT EXISTS idx_raid_members_user ON raid_members(user_id);

        -- One row per pop attempt: the window the leader had, and what the
        -- watcher saw (lib/raids.ts). The raid's pops_done counts the
        -- confirmed ones.
        CREATE TABLE IF NOT EXISTS raid_pops (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          raid_id INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
          n INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          window_ends_at INTEGER NOT NULL,
          -- pending, confirmed, other, none, unverified
          verdict TEXT NOT NULL DEFAULT 'pending',
          popped_at INTEGER,
          opener_ign TEXT,
          opener_account TEXT,
          portal_type INTEGER,
          portal_object_id INTEGER,
          dungeon TEXT NOT NULL DEFAULT '',
          modifiers TEXT,
          opened_at_stamp INTEGER,
          beside_json TEXT,
          roster_json TEXT,
          present_json TEXT,
          entered_count INTEGER,
          closed_at INTEGER,
          note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_raid_pops_raid ON raid_pops(raid_id, n);

        -- Append-only audit of everything a raid went through. No foreign
        -- key on purpose: it outlives the raid row (deleted a day after the
        -- end) and is what the players' raid histories are counted from.
        CREATE TABLE IF NOT EXISTS raid_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          raid_id INTEGER NOT NULL,
          event TEXT NOT NULL,
          -- The player the event is about (the leader for raid.created / pop.*, the raider for raid.joined / raid.present), or ''.
          ign_lower TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT '',
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_raid_events_raid ON raid_events(raid_id, id);
        CREATE INDEX IF NOT EXISTS idx_raid_events_ign ON raid_events(ign_lower, event);
      `);
    },
  },
  {
    id: 9,
    name: "raid_leader_range",
    up(db) {
      // The watcher only sees a pop within its view: it tracks whether the
      // raid's leader is close enough (whispering them when they stray) and
      // the site shows it. NULL = the watcher has not seen the leader yet.
      db.exec(`
        ALTER TABLE raids ADD COLUMN leader_in_range INTEGER;
        ALTER TABLE raids ADD COLUMN leader_distance REAL;
      `);
    },
  },
  {
    id: 10,
    name: "raid_strikes",
    up(db) {
      // A strike against a leader (lib/raids.ts): a raid that ended because
      // a watcher saw no pop, or one cancelled after the AFK check had sent
      // raiders moving. Strikes decay after 30 days and stack into posting
      // cooldowns; an operator clears them (cleared_at).
      db.exec(`
        CREATE TABLE IF NOT EXISTS raid_strikes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          ign_lower TEXT NOT NULL,
          ign TEXT NOT NULL,
          -- no_pop, cancelled
          kind TEXT NOT NULL,
          raid_id INTEGER NOT NULL,
          at INTEGER NOT NULL,
          cleared_at INTEGER,
          cleared_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_raid_strikes_user ON raid_strikes(user_id, at);
        CREATE INDEX IF NOT EXISTS idx_raid_strikes_ign ON raid_strikes(ign_lower, at);
      `);
    },
  },
  {
    id: 11,
    name: "raid_rewards",
    up(db) {
      // Points paid for a raid (lib/raids.ts portalClosed, docs/RAIDS.md
      // §7c): when a watcher-confirmed portal closes, the leader earns a
      // share per raider seen going in and each of those raiders earns
      // theirs. One row per payee per pop; the points are stored as paid,
      // so a later rate change never rescores an old raid. No foreign key
      // on the raid: the raid row is deleted a day after it ends, the
      // reward stays. lib/leaderboard.ts adds these to the score.
      db.exec(`
        CREATE TABLE IF NOT EXISTS raid_rewards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          raid_id INTEGER NOT NULL,
          pop_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          ign_lower TEXT NOT NULL,
          ign TEXT NOT NULL,
          -- leader, raider
          role TEXT NOT NULL,
          -- what the row is for: the dungeon and, for the leader, how many raiders it counted
          detail TEXT NOT NULL DEFAULT '',
          points REAL NOT NULL CHECK (points >= 0),
          at INTEGER NOT NULL,
          UNIQUE (pop_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_raid_rewards_ign ON raid_rewards(ign_lower, at);
        CREATE INDEX IF NOT EXISTS idx_raid_rewards_raid ON raid_rewards(raid_id);
        -- What the leader earned for the pop, shown on the card beside the entered count.
        ALTER TABLE raid_pops ADD COLUMN leader_points REAL;
      `);
    },
  },
  {
    id: 12,
    name: "realmhunts",
    up(db) {
      // Realm hunting (lib/realmhunts.ts, docs/REALMHUNTS.md): a request for
      // a dungeon in a region, served by a fleet bot that holds an in-game
      // party open in the Nexus and, on a member's call, teleports to them
      // and counts who follows. The server is picked when the hunt is
      // posted; party id, members and the hunter's state are what the bot
      // reports. (realm is unused: an early design had the bot in a realm.)
      db.exec(`
        CREATE TABLE IF NOT EXISTS realmhunts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dungeon_id TEXT NOT NULL,
          region TEXT NOT NULL,
          requester_user_id INTEGER NOT NULL REFERENCES users(id),
          requester_ign TEXT NOT NULL,
          requester_ign_lower TEXT NOT NULL,
          -- open, ended
          status TEXT NOT NULL,
          server TEXT NOT NULL,
          realm TEXT NOT NULL DEFAULT '',
          party_name TEXT NOT NULL,
          party_id INTEGER NOT NULL DEFAULT 0,
          -- The hunter bot's progress as last reported (lib/realmhuntRules.ts HunterState).
          hunter_state TEXT NOT NULL DEFAULT 'none',
          hunter_note TEXT NOT NULL DEFAULT '',
          hunter_bot TEXT,
          hunter_since INTEGER,
          -- Party members the hunter saw join: ["name", ...].
          members_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ended_at INTEGER,
          -- requester, timeout, operator, hunter
          ended_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_realmhunts_status ON realmhunts(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_realmhunts_requester ON realmhunts(requester_user_id, status);
        -- One row per join call the hunter answered: who called, and what it counted.
        CREATE TABLE IF NOT EXISTS realmhunt_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hunt_id INTEGER NOT NULL REFERENCES realmhunts(id) ON DELETE CASCADE,
          caller_ign TEXT NOT NULL,
          caller_ign_lower TEXT NOT NULL,
          at INTEGER NOT NULL,
          entered INTEGER,
          party_entered INTEGER,
          -- counted, not_in_sight, no_portal, failed; NULL while in progress
          outcome TEXT,
          note TEXT NOT NULL DEFAULT '',
          done_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_realmhunt_calls_hunt ON realmhunt_calls(hunt_id, at);
        -- Audit: outlives the hunt row.
        CREATE TABLE IF NOT EXISTS realmhunt_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hunt_id INTEGER NOT NULL,
          event TEXT NOT NULL,
          ign_lower TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT '',
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_realmhunt_events_hunt ON realmhunt_events(hunt_id, id);
      `);
    },
  },
  {
    id: 13,
    name: "realmhunt_rewards",
    up(db) {
      // Points paid for a realm hunt call (lib/realmhunts.ts callDone): when
      // the hunter counted a call into the hunted dungeon, each party member
      // it saw there earns theirs and the caller who found it earns a share
      // per member. Stored as paid, like raid_rewards; no foreign key on the
      // hunt (its row is deleted a day after it ends). lib/leaderboard.ts
      // adds these to the score.
      db.exec(`
        CREATE TABLE IF NOT EXISTS realmhunt_rewards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hunt_id INTEGER NOT NULL,
          call_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          ign_lower TEXT NOT NULL,
          ign TEXT NOT NULL,
          -- finder, hunter
          role TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          points REAL NOT NULL CHECK (points >= 0),
          at INTEGER NOT NULL,
          UNIQUE (call_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_realmhunt_rewards_ign ON realmhunt_rewards(ign_lower, at);
        ALTER TABLE realmhunt_calls ADD COLUMN finder_points REAL NOT NULL DEFAULT 0;
        ALTER TABLE realmhunt_calls ADD COLUMN entered_json TEXT NOT NULL DEFAULT '[]';
      `);
    },
  },
  {
    id: 14,
    name: "realmhunts_one_per_region",
    up(db) {
      // One open hunt per region (lib/realmhunts.ts createHunt checks it;
      // this index makes a race lose too). Any extra open hunts a region
      // has right now are closed first, newest kept.
      db.exec(`
        UPDATE realmhunts SET status = 'ended', ended_at = ${Date.now()}, ended_by = 'operator'
         WHERE status <> 'ended' AND id NOT IN (SELECT MAX(id) FROM realmhunts WHERE status <> 'ended' GROUP BY region);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_realmhunts_open_region ON realmhunts(region) WHERE status <> 'ended';
      `);
    },
  },
  {
    id: 15,
    name: "realmhunts_one_per_dungeon_region",
    up(db) {
      // Migration 14 was too strict: a region may run several hunts, one per
      // dungeon. The index moves to (dungeon, region).
      db.exec(`
        DROP INDEX IF EXISTS idx_realmhunts_open_region;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_realmhunts_open_dungeon_region ON realmhunts(dungeon_id, region) WHERE status <> 'ended';
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
