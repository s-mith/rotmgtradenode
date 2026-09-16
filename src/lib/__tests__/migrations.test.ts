// Schema migrations against a database in the shape they expect to find:
// the one-vault-per-user layout of migration 3/4 is split into two halves
// by migration 5 without losing a slot, a bot or a wish.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS, runMigrations } from "../migrations";

/** The base tables the early migrations alter, in the minimum shape they need. */
function preMigrationDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE deposit_requests (id INTEGER PRIMARY KEY, seasonal INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE withdraw_requests (id INTEGER PRIMARY KEY, seasonal INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending');
  `);
  return db;
}

describe("migration 5: vault halves", () => {
  it("moves each vault into the half it was allocated to, leaves the other empty, and tags wishes", () => {
    const db = preMigrationDb();
    runMigrations(db, MIGRATIONS.filter((m) => m.id <= 4));
    db.exec(`
      INSERT INTO users (id, created_at, vault_seasonal, vault_slots, vault_bot_guid, vault_bot_since) VALUES
        (1, 1, 1, 8, 'bot-S', 100),
        (2, 1, 0, 16, 'bot-N', 200),
        (3, 1, 1, 8, NULL, NULL);
      INSERT INTO wishlist_rules (user_id, item_id, slots_min, slots_exact, match_json, enabled, hits, last_hit_at, created_at, updated_at) VALUES
        (1, 'ubatk', 0, NULL, '{}', 1, 0, NULL, 1, 1),
        (2, 'ubatk', 0, NULL, '{}', 1, 0, NULL, 1, 1);
    `);
    expect(runMigrations(db, MIGRATIONS.filter((m) => m.id <= 5))).toEqual([5]);
    expect(db.prepare("SELECT user_id, seasonal, slots, bot_guid, bot_since FROM vault_halves ORDER BY user_id, seasonal DESC").all()).toEqual([
      { user_id: 1, seasonal: 1, slots: 8, bot_guid: "bot-S", bot_since: 100 },
      { user_id: 1, seasonal: 0, slots: 0, bot_guid: null, bot_since: null },
      { user_id: 2, seasonal: 1, slots: 0, bot_guid: null, bot_since: null },
      { user_id: 2, seasonal: 0, slots: 16, bot_guid: "bot-N", bot_since: 200 },
      { user_id: 3, seasonal: 1, slots: 8, bot_guid: null, bot_since: null },
      { user_id: 3, seasonal: 0, slots: 0, bot_guid: null, bot_since: null },
    ]);
    expect(db.prepare("SELECT user_id, seasonal FROM wishlist_rules ORDER BY user_id").all()).toEqual([
      { user_id: 1, seasonal: 1 },
      { user_id: 2, seasonal: 0 },
    ]);
    // The entitlement stays on the user; the per-vault columns are gone or blank.
    const cols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("vault_slots");
    expect(cols).not.toContain("vault_seasonal");
    expect(cols).not.toContain("vault_bot_since");
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE vault_bot_guid IS NOT NULL").get()).toEqual({ n: 0 });
    // A bot can't serve two halves.
    expect(() => db.prepare("UPDATE vault_halves SET bot_guid = 'bot-S' WHERE user_id = 2 AND seasonal = 0").run()).toThrow(/UNIQUE/);
    db.close();
  });
});
