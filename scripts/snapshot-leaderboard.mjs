// Capture a running site's leaderboard into src/lib/leaderboard-baseline.json
// so the scores survive a database wipe (e.g. a Railway deploy that had no
// volume attached). The API adds live ledger points on top of this baseline.
//
//   node scripts/snapshot-leaderboard.mjs https://<site-host>
//
// Idempotent BUT NOT CUMULATIVE: it overwrites the baseline with exactly
// what the target site reports. Since the site's own response already
// includes its baseline + live points, re-snapshotting the same site is
// safe (totals, not deltas). Never snapshot a site whose DB still contains
// history that's already in the baseline AND ALSO re-add that history —
// that can't happen via this script, only by hand-editing the JSON.

import fs from "node:fs";
import path from "node:path";

const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node scripts/snapshot-leaderboard.mjs https://<site-host>");
  process.exit(1);
}

const OUT = path.join(process.cwd(), "src", "lib", "leaderboard-baseline.json");

const res = await fetch(`${base}/api/leaderboard`, { headers: { accept: "application/json" } });
if (!res.ok) {
  console.error(`GET ${base}/api/leaderboard -> HTTP ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const players = Array.isArray(data?.players) ? data.players : null;
if (!players) {
  console.error("response has no players array — is that the right site?");
  process.exit(1);
}

const baseline = players
  .filter((p) => p && typeof p.ign === "string" && p.ign)
  .map((p) => ({
    ign: p.ign,
    points: Number(p.points) || 0,
    deposited: Number(p.deposited) || 0,
    withdrawn: Number(p.withdrawn) || 0,
  }));

fs.writeFileSync(OUT, JSON.stringify(baseline, null, 2) + "\n");
console.log(`wrote ${baseline.length} player(s) to ${OUT}`);
for (const b of baseline) console.log(`  ${b.ign}: ${b.points} pts (${b.deposited} dep / ${b.withdrawn} wd)`);
