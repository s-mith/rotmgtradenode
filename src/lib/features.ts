import type Database from "better-sqlite3";

// Operator-granted features. A grant names a character (IGN); a logged-in
// user holds the feature when any character linked to their account is
// granted, so the operator only has to know one of a player's names.
//
// The list of features is closed: a grant for an unknown feature name is
// refused so a typo in the console can't silently do nothing.

export const FEATURES = {
  wishlist: "My Wishlist — standing claims that pull matching pool arrivals into the vault",
} as const;

export type Feature = keyof typeof FEATURES;

export function isFeature(v: unknown): v is Feature {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FEATURES, v);
}

export interface FeatureGrant {
  feature: Feature;
  ign: string;
  ignLower: string;
  grantedAt: number;
}

type Row = { feature: Feature; ign: string; ign_lower: string; granted_at: number };
const toGrant = (r: Row): FeatureGrant => ({ feature: r.feature, ign: r.ign, ignLower: r.ign_lower, grantedAt: r.granted_at });

export function listFeatureGrants(db: Database.Database): FeatureGrant[] {
  return (db.prepare("SELECT * FROM feature_grants ORDER BY feature, granted_at DESC").all() as Row[]).map(toGrant);
}

export function grantFeature(db: Database.Database, feature: Feature, ign: string, ignLower: string, now = Date.now()): FeatureGrant {
  db.prepare(
    `INSERT INTO feature_grants (ign_lower, feature, ign, granted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(ign_lower, feature) DO UPDATE SET ign = excluded.ign`,
  ).run(ignLower, feature, ign, now);
  return toGrant(db.prepare("SELECT * FROM feature_grants WHERE ign_lower = ? AND feature = ?").get(ignLower, feature) as Row);
}

export function revokeFeature(db: Database.Database, feature: Feature, ignLower: string): boolean {
  return db.prepare("DELETE FROM feature_grants WHERE ign_lower = ? AND feature = ?").run(ignLower, feature).changes > 0;
}

/** Every feature the user's linked characters unlock, sorted. */
export function featuresOf(db: Database.Database, userId: number): Feature[] {
  const rows = db
    .prepare("SELECT DISTINCT g.feature FROM feature_grants g JOIN user_igns u ON u.ign_lower = g.ign_lower WHERE u.user_id = ? ORDER BY g.feature")
    .all(userId) as { feature: string }[];
  return rows.map((r) => r.feature).filter(isFeature);
}

export function userHasFeature(db: Database.Database, userId: number, feature: Feature): boolean {
  return featuresOf(db, userId).includes(feature);
}
