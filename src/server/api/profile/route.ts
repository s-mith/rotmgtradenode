import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { ITEM_BY_ID } from "@/lib/catalog";
import { spriteForItemName } from "@/lib/sprites";
import { computePlayers, pointsAt, rankedPlayers, roundPoints } from "@/lib/leaderboard";
import { getGrant, isPlainStyle } from "@/lib/cosmetics";
import { notASkin } from "@/lib/skins";
import { raidHistoryFor } from "@/lib/raids";


// GET /api/profile?ign=<name> — everything the GitHub-style comrade page
// shows: totals + rank (same math as the leaderboard, shared lib), a
// daily net-points series for the contribution calendar, and the player's
// transaction history as a commit log.
//
// Calendar semantics: one bucket per UTC day, net points = deposits earn,
// withdrawals cost, each valued by the era its transaction happened in.
// Green days gave to the collective; red days took from it.

const CALENDAR_DAYS = 371; // 53 weeks — the grid aligns itself to weeks
const ACTIVITY_LIMIT = 200;

export async function GET(req: Request) {
  const ignRaw = (new URL(req.url).searchParams.get("ign") ?? "").trim();
  const ignLower = ignRaw.toLowerCase();
  if (!ignLower || ignLower.length > 32) {
    return json({ error: "Bad ign" }, { status: 400 });
  }

  const db = getDb();
  const players = computePlayers(db);
  // Two different lists on purpose. `players` still holds everyone, because a
  // disqualified player's own profile must keep showing what they actually
  // contributed — the disqualification takes them off the boards, it doesn't
  // erase their ledger. `ranked` is what positions are measured against, so a
  // hidden player neither holds a rank nor pushes anyone else down one.
  const ranked = rankedPlayers(players);
  const me0 = players.find((p) => p.ignLower === ignLower);
  const idx = ranked.findIndex((p) => p.ignLower === ignLower);

  const rows = db
    .prepare(
      `SELECT kind, item_id, qty, enchants, server, created_at
         FROM transactions WHERE ign_lower = ? AND ${notASkin()}
        ORDER BY created_at DESC, id DESC`,
    )
    .all(ignLower) as {
    kind: "deposit" | "withdraw";
    item_id: string;
    qty: number;
    enchants: number;
    server: string | null;
    created_at: number;
  }[];

  // "No such comrade" asks whether we have ever heard of them at all, so it
  // reads the full list — a disqualified player still has a profile, and so
  // does a raider who has never traded.
  const raids = raidHistoryFor(db, ignLower);
  const rewards = db
    .prepare("SELECT raid_id, role, detail, points, at FROM raid_rewards WHERE ign_lower = ? ORDER BY at DESC, id DESC")
    .all(ignLower) as { raid_id: number; role: "leader" | "raider"; detail: string; points: number; at: number }[];
  const huntRewards = db
    .prepare("SELECT hunt_id, role, detail, points, at FROM realmhunt_rewards WHERE ign_lower = ? ORDER BY at DESC, id DESC")
    .all(ignLower) as { hunt_id: number; role: "finder" | "hunter"; detail: string; points: number; at: number }[];
  if (!me0 && rows.length === 0 && raids.led + raids.joined === 0 && huntRewards.length === 0) {
    return json({ error: "No such comrade" }, { status: 404 });
  }

  const me = me0 ?? null;

  // --- daily net points for the calendar (UTC days) -----------------------
  const since = Date.now() - CALENDAR_DAYS * 24 * 60 * 60 * 1000;
  const byDay = new Map<string, { points: number; deposited: number; withdrawn: number }>();
  for (const r of rows) {
    if (r.created_at < since) continue;
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = { points: 0, deposited: 0, withdrawn: 0 };
      byDay.set(day, d);
    }
    const pts = pointsAt(r.item_id, r.created_at, r.enchants) * r.qty;
    if (r.kind === "deposit") {
      d.points += pts;
      d.deposited += r.qty;
    } else {
      d.points -= pts;
      d.withdrawn += r.qty;
    }
  }
  // Raid points land on the day they were paid, like a deposit would.
  for (const r of rewards) {
    if (r.at < since) continue;
    const day = new Date(r.at).toISOString().slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = { points: 0, deposited: 0, withdrawn: 0 };
      byDay.set(day, d);
    }
    d.points += r.points;
  }
  const days = [...byDay.entries()]
    .map(([date, d]) => ({ date, ...d, points: roundPoints(d.points) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // --- commit-log activity -------------------------------------------------
  // Ledger rows and raid rewards, newest first, cut to the limit together.
  const activity = [
    ...rows.map((r) => {
      const item = ITEM_BY_ID.get(r.item_id);
      const name = item?.name ?? r.item_id;
      return {
        kind: r.kind as "deposit" | "withdraw" | "raid",
        itemId: r.item_id,
        itemName: name,
        sprite: spriteForItemName(name),
        qty: r.qty,
        enchants: r.enchants,
        // What this transaction was worth when it happened (signed).
        points: roundPoints(
          pointsAt(r.item_id, r.created_at, r.enchants) * r.qty * (r.kind === "deposit" ? 1 : -1),
        ),
        server: r.server,
        createdAt: r.created_at,
      };
    }),
    ...rewards.map((r) => ({
      kind: "raid" as const,
      itemId: `raid:${r.raid_id}`,
      itemName: r.role === "leader" ? `Led a raid · ${r.detail}` : `Raided · ${r.detail}`,
      sprite: null,
      qty: 1,
      enchants: 0,
      points: roundPoints(r.points),
      server: null,
      createdAt: r.at,
    })),
    ...huntRewards.map((r) => ({
      kind: "raid" as const,
      itemId: `hunt:${r.hunt_id}`,
      itemName: r.role === "finder" ? `Found a dungeon · ${r.detail}` : `Realm hunted · ${r.detail}`,
      sprite: null,
      qty: 1,
      enchants: 0,
      points: roundPoints(r.points),
      server: null,
      createdAt: r.at,
    })),
  ]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, ACTIVITY_LIMIT);

  // --- signature item: most deposited, all-time ----------------------------
  const depositCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "deposit") continue;
    depositCounts.set(r.item_id, (depositCounts.get(r.item_id) ?? 0) + r.qty);
  }
  let signature: { itemName: string; sprite: string | null; qty: number } | null = null;
  for (const [itemId, qty] of depositCounts) {
    if (!signature || qty > signature.qty) {
      const name = ITEM_BY_ID.get(itemId)?.name ?? itemId;
      signature = { itemName: name, sprite: spriteForItemName(name), qty };
    }
  }

  const firstAt = rows.length > 0 ? rows[rows.length - 1].created_at : null;

  return json({
    ok: true,
    // Casing: prefer the leaderboard's (most recent the player typed);
    // fall back to however the URL spelled it.
    ign: me?.ign ?? ignRaw,
    // Donator name effect, or null when this player has no live grant (or
    // has one but picked plain). The profile header renders it.
    nameStyle: (() => {
      const g = getGrant(db, ignLower);
      return g && g.enabled && !isPlainStyle(g.style) ? g.style : null;
    })(),
    points: me?.points ?? 0,
    // 1-based rank across every RANKED player, best first. null for players
    // who only exist as ledger rows that net to a baseline-less 0, and for
    // anyone disqualified — they hold no position on the boards.
    rank: idx >= 0 ? idx + 1 : null,
    // Raids led, pops a watcher confirmed, raids ended for no pop, raids
    // joined and raids the watcher saw them show up to (lib/raids.ts).
    raids,
    totalPlayers: ranked.length,
    // Operator has taken them off the boards. Their points and history below
    // are unaffected and still theirs; only the ranking hides them.
    disqualified: me?.disqualified ?? false,
    deposited: me?.deposited ?? 0,
    withdrawn: me?.withdrawn ?? 0,
    // First ledger row. Baseline-only comrades predate the current DB —
    // null here, and the UI says so.
    comradeSince: firstAt,
    baselineOnly: rows.length === 0,
    days,
    activity,
    signature,
  });
}
