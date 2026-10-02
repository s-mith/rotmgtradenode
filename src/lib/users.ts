// Player accounts: one user, any number of linked in-game names.
//
// A session still proves control of ONE character (lib/session.ts: the cookie
// carries the IGN a /tell came from), and the ledger still scores per IGN.
// What a user adds is the thing that spans characters: the list of names a
// player may switch between without pasting another /tell, and one set of
// open requests. Linking a further IGN uses the same proof as logging in.
import type Database from "better-sqlite3";
import { sessionFromRequest } from "./session";

export interface LinkedIgn {
  ign: string;
  ignLower: string;
  linkedAt: number;
}

export interface SessionUser {
  userId: number;
  /** The character this session is acting as. */
  ign: string;
  ignLower: string;
  igns: LinkedIgn[];
}

/** The user an IGN belongs to, creating one for a name nobody has linked. */
export function userForIgn(db: Database.Database, ign: string, ignLower: string): number {
  const row = db.prepare("SELECT user_id FROM user_igns WHERE ign_lower = ?").get(ignLower) as { user_id: number } | undefined;
  if (row) {
    // Keep the display casing current: the ledger does the same.
    db.prepare("UPDATE user_igns SET ign = ? WHERE ign_lower = ? AND ign <> ?").run(ign, ignLower, ign);
    return row.user_id;
  }
  const now = Date.now();
  return db.transaction(() => {
    const again = db.prepare("SELECT user_id FROM user_igns WHERE ign_lower = ?").get(ignLower) as { user_id: number } | undefined;
    if (again) return again.user_id;
    const userId = Number(db.prepare("INSERT INTO users (created_at) VALUES (?)").run(now).lastInsertRowid);
    db.prepare("INSERT INTO user_igns (ign_lower, ign, user_id, linked_at) VALUES (?, ?, ?, ?)").run(ignLower, ign, userId, now);
    return userId;
  }).immediate();
}

export function ignsOf(db: Database.Database, userId: number): LinkedIgn[] {
  return (db.prepare("SELECT ign, ign_lower, linked_at FROM user_igns WHERE user_id = ? ORDER BY linked_at, rowid").all(userId) as { ign: string; ign_lower: string; linked_at: number }[])
    .map((r) => ({ ign: r.ign, ignLower: r.ign_lower, linkedAt: r.linked_at }));
}

/** Everything the session says, resolved to its user. Null when not logged in. */
export function sessionUser(db: Database.Database, req: Request): SessionUser | null {
  const s = sessionFromRequest(req);
  if (!s) return null;
  const userId = userForIgn(db, s.ign, s.ignLower);
  return { userId, ign: s.ign, ignLower: s.ignLower, igns: ignsOf(db, userId) };
}

export type LinkResult = { ok: true; absorbed: boolean } | { ok: false; status: number; error: string };

/**
 * Attach `ign` to `userId`. The name may already have a user of its own —
 * every character that ever logged in does — and that user is absorbed when it
 * amounts to nothing (no other names). One with other names is a real
 * account; the player is told to unlink the name there first.
 */
export function linkIgn(db: Database.Database, userId: number, ign: string, ignLower: string): LinkResult {
  return db.transaction((): LinkResult => {
    const cur = db.prepare("SELECT user_id FROM user_igns WHERE ign_lower = ?").get(ignLower) as { user_id: number } | undefined;
    const now = Date.now();
    if (!cur) {
      db.prepare("INSERT INTO user_igns (ign_lower, ign, user_id, linked_at) VALUES (?, ?, ?, ?)").run(ignLower, ign, userId, now);
      return { ok: true, absorbed: false };
    }
    if (cur.user_id === userId) return { ok: true, absorbed: false };
    const others = (db.prepare("SELECT COUNT(*) AS n FROM user_igns WHERE user_id = ? AND ign_lower <> ?").get(cur.user_id, ignLower) as { n: number }).n;
    if (others > 0) {
      return { ok: false, status: 409, error: `${ign} already belongs to another account with other characters on it. Log in as ${ign} and unlink it there first.` };
    }
    db.prepare("UPDATE user_igns SET user_id = ?, ign = ?, linked_at = ? WHERE ign_lower = ?").run(userId, ign, now, ignLower);
    db.prepare("DELETE FROM users WHERE id = ?").run(cur.user_id);
    return { ok: true, absorbed: true };
  }).immediate();
}

export type UnlinkResult = { ok: true; remaining: LinkedIgn[] } | { ok: false; status: number; error: string };

/** Detach a name. The last one stays: a user with no way to log in is a dead account. */
export function unlinkIgn(db: Database.Database, userId: number, ignLower: string): UnlinkResult {
  return db.transaction((): UnlinkResult => {
    const mine = ignsOf(db, userId);
    if (!mine.some((i) => i.ignLower === ignLower)) return { ok: false, status: 404, error: "That character isn't linked to this account." };
    if (mine.length === 1) return { ok: false, status: 409, error: "You can't unlink your only character." };
    db.prepare("DELETE FROM user_igns WHERE ign_lower = ? AND user_id = ?").run(ignLower, userId);
    return { ok: true, remaining: ignsOf(db, userId) };
  }).immediate();
}
