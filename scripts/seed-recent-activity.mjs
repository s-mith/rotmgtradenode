// Seeds the transactions ledger with mock deposits/withdrawals so the
// Recent Activity panel has something to show in dev.
//
//   node scripts/seed-recent-activity.mjs         # insert ~20 mock rows
//   node scripts/seed-recent-activity.mjs --clear # remove ONLY mock rows
//
// Mock rows are tagged with server 'MOCK' so --clear can find them without
// touching any real ledger data.
import Database from "better-sqlite3";
import path from "node:path";

const db = new Database(path.join("data", "pool.db"));
const MOCK_SERVER = "MOCK";

if (process.argv.includes("--clear")) {
  const { changes } = db.prepare("DELETE FROM transactions WHERE server = ?").run(MOCK_SERVER);
  console.log(`Removed ${changes} mock rows.`);
  process.exit(0);
}

const igns = ["Proletariat", "RedStar", "Comraddish", "VaultKeeper", "Trotsky42", "Babushka"];
const items = [
  "Doom Bow",
  "Coral Silk Armor",
  "Crystal Wand",
  "Ring of Decades",
  "Harlequin Armor",
  "Robe of the Star Mother",
  "Dominion Armor",
  "Bow of Mystical Energy",
  "Helm of the Great General",
  "Cloak of Ghostly Concealment",
  "Sword of Splendor",
  "The Forgotten Ring",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const insert = db.prepare(
  `INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, server, created_at)
   VALUES (@kind, @ign, @ign_lower, @item_id, @qty, @server, @created_at)`,
);

const now = Date.now(); // ms epoch, matching the real ledger
const seed = db.transaction((n) => {
  for (let i = 0; i < n; i++) {
    const ign = pick(igns);
    insert.run({
      kind: Math.random() < 0.6 ? "deposit" : "withdraw",
      ign,
      ign_lower: ign.toLowerCase(),
      item_id: pick(items),
      qty: 1 + Math.floor(Math.random() * 4),
      server: MOCK_SERVER,
      // Spread over the last few hours, newest first-ish (ms).
      created_at: now - i * (120 + Math.floor(Math.random() * 900)) * 1000,
    });
  }
});

seed(20);
console.log("Inserted 20 mock rows (server='MOCK'). Run with --clear to remove them.");
