// Donator name cosmetics — Minecraft-style text effects applied to a
// player's IGN wherever the site prints it (leaderboard, recent activity,
// comrade profile).
//
// Two independent pieces of state per player, both in player_cosmetics:
//
//   enabled   — the operator's grant, toggled from /dev/settings → Cosmetics.
//               This is the ONLY thing that decides whether a style renders.
//   styleJson — the player's own pick, chosen from the in-page menu.
//
// They're deliberately separate rows-fields rather than one: revoking a
// grant leaves the style stored, so re-granting restores what the player
// had instead of resetting them to plain.
//
// Everything a client can send is re-validated here (parseNameStyle) before
// it's stored, and the render path only ever emits values that came back
// out of this module. A player can't hand us a colour, a class name, or any
// other string that reaches the DOM — the wire format is an enum of ids.
import type Database from "better-sqlite3";

// The 16 Minecraft chat colours, in §-code order. `code` is the legacy
// formatting code purely so the picker can show it; nothing parses it.
export const MC_COLORS = [
  { id: "black", label: "Black", hex: "#000000", code: "0" },
  { id: "dark_blue", label: "Dark Blue", hex: "#0000AA", code: "1" },
  { id: "dark_green", label: "Dark Green", hex: "#00AA00", code: "2" },
  { id: "dark_aqua", label: "Dark Aqua", hex: "#00AAAA", code: "3" },
  { id: "dark_red", label: "Dark Red", hex: "#AA0000", code: "4" },
  { id: "dark_purple", label: "Dark Purple", hex: "#AA00AA", code: "5" },
  { id: "gold", label: "Gold", hex: "#FFAA00", code: "6" },
  { id: "gray", label: "Gray", hex: "#AAAAAA", code: "7" },
  { id: "dark_gray", label: "Dark Gray", hex: "#555555", code: "8" },
  { id: "blue", label: "Blue", hex: "#5555FF", code: "9" },
  { id: "green", label: "Green", hex: "#55FF55", code: "a" },
  { id: "aqua", label: "Aqua", hex: "#55FFFF", code: "b" },
  { id: "red", label: "Red", hex: "#FF5555", code: "c" },
  { id: "light_purple", label: "Light Purple", hex: "#FF55FF", code: "d" },
  { id: "yellow", label: "Yellow", hex: "#FFFF55", code: "e" },
  { id: "white", label: "White", hex: "#FFFFFF", code: "f" },
] as const;

export type McColorId = (typeof MC_COLORS)[number]["id"];

const COLOR_HEX = new Map<string, string>(MC_COLORS.map((c) => [c.id, c.hex]));

/** Hex for a colour id, or null if the id isn't one of the 16. */
export function colorHex(id: string | null | undefined): string | null {
  return id ? COLOR_HEX.get(id) ?? null : null;
}

export const EFFECTS = ["plain", "solid", "gradient", "rainbow"] as const;
export type EffectId = (typeof EFFECTS)[number];

// Flat on purpose: it's the wire format, the DB format and the form state
// all at once, so a nested union would just mean three sets of adapters.
// Fields not relevant to `effect` are kept (not nulled) so a player can
// flip between gradient and rainbow without losing their colour pick.
export type NameStyle = {
  effect: EffectId;
  /** solid only */
  color: McColorId;
  /** gradient endpoints */
  from: McColorId;
  to: McColorId;
  /** gradient/rainbow: sweep the fill instead of holding it still */
  animated: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** §k — scrambles the glyphs; the real IGN stays in the title/aria label */
  obfuscated: boolean;
};

export const DEFAULT_STYLE: NameStyle = {
  effect: "plain",
  color: "white",
  from: "gold",
  to: "red",
  animated: false,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  obfuscated: false,
};

/** True when the style would render identically to an unstyled IGN. */
export function isPlainStyle(s: NameStyle): boolean {
  return (
    s.effect === "plain" &&
    !s.bold &&
    !s.italic &&
    !s.underline &&
    !s.strike &&
    !s.obfuscated
  );
}

function asColor(v: unknown, fallback: McColorId): McColorId {
  return typeof v === "string" && COLOR_HEX.has(v) ? (v as McColorId) : fallback;
}

/**
 * Coerce untrusted input into a NameStyle. Unknown effects, unknown colour
 * ids and non-booleans fall back to the default rather than 400-ing — the
 * menu can only produce valid values, so anything else is either a stale
 * client or someone poking the endpoint, and neither deserves a style it
 * didn't earn. Returns null only when the input isn't an object at all.
 */
export function parseNameStyle(raw: unknown): NameStyle | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const effect = EFFECTS.includes(r.effect as EffectId)
    ? (r.effect as EffectId)
    : DEFAULT_STYLE.effect;
  return {
    effect,
    color: asColor(r.color, DEFAULT_STYLE.color),
    from: asColor(r.from, DEFAULT_STYLE.from),
    to: asColor(r.to, DEFAULT_STYLE.to),
    animated: r.animated === true,
    bold: r.bold === true,
    italic: r.italic === true,
    underline: r.underline === true,
    strike: r.strike === true,
    obfuscated: r.obfuscated === true,
  };
}

// --- storage --------------------------------------------------------------

export type CosmeticGrant = {
  ign: string;
  ignLower: string;
  enabled: boolean;
  style: NameStyle;
  grantedAt: number;
  updatedAt: number;
};

type CosmeticRow = {
  ign_lower: string;
  ign: string;
  enabled: number;
  style_json: string;
  granted_at: number;
  updated_at: number;
};

function rowToGrant(r: CosmeticRow): CosmeticGrant {
  let style = DEFAULT_STYLE;
  try {
    style = parseNameStyle(JSON.parse(r.style_json)) ?? DEFAULT_STYLE;
  } catch {
    // hand-edited or pre-format row — fall back to plain
  }
  return {
    ign: r.ign,
    ignLower: r.ign_lower,
    enabled: r.enabled === 1,
    style,
    grantedAt: r.granted_at,
    updatedAt: r.updated_at,
  };
}

/** Every row the operator console shows, granted or revoked, newest first. */
export function listGrants(db: Database.Database): CosmeticGrant[] {
  const rows = db
    .prepare("SELECT * FROM player_cosmetics ORDER BY enabled DESC, granted_at DESC")
    .all() as CosmeticRow[];
  return rows.map(rowToGrant);
}

export function getGrant(db: Database.Database, ignLower: string): CosmeticGrant | null {
  const row = db
    .prepare("SELECT * FROM player_cosmetics WHERE ign_lower = ?")
    .get(ignLower) as CosmeticRow | undefined;
  return row ? rowToGrant(row) : null;
}

/**
 * Operator action: grant or revoke. Creates the row on first grant with the
 * default (plain) style; on an existing row only `enabled` and the display
 * casing move, so a revoke-then-regrant restores the player's own pick.
 */
export function setEnabled(
  db: Database.Database,
  ign: string,
  ignLower: string,
  enabled: boolean,
): CosmeticGrant {
  const now = Date.now();
  db.prepare(
    `INSERT INTO player_cosmetics
       (ign_lower, ign, enabled, style_json, granted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ign_lower) DO UPDATE SET
       ign = excluded.ign,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(ignLower, ign, enabled ? 1 : 0, JSON.stringify(DEFAULT_STYLE), now, now);
  return getGrant(db, ignLower)!;
}

/**
 * Player action: store a style pick. Refuses when the IGN has no live grant —
 * the menu is hidden for non-donators, but the endpoint is what enforces it,
 * so hitting it directly gets you nothing.
 */
export function setStyle(
  db: Database.Database,
  ignLower: string,
  style: NameStyle,
): { ok: true; grant: CosmeticGrant } | { ok: false; error: string } {
  const grant = getGrant(db, ignLower);
  if (!grant || !grant.enabled) {
    return { ok: false, error: "Name effects aren't enabled for this account." };
  }
  db.prepare(
    "UPDATE player_cosmetics SET style_json = ?, updated_at = ? WHERE ign_lower = ?",
  ).run(JSON.stringify(style), Date.now(), ignLower);
  return { ok: true, grant: getGrant(db, ignLower)! };
}

export function removeGrant(db: Database.Database, ignLower: string): boolean {
  return db.prepare("DELETE FROM player_cosmetics WHERE ign_lower = ?").run(ignLower).changes > 0;
}

/**
 * Bulk lookup for list endpoints: ignLower -> style, for granted players
 * only, and omitting anyone whose style is plain anyway. Callers spread the
 * result onto their rows, so a board of 50 names costs one query and the
 * payload only grows for players who actually have an effect on.
 */
export function stylesFor(
  db: Database.Database,
  ignLowers: string[],
): Record<string, NameStyle> {
  const uniq = [...new Set(ignLowers)].filter(Boolean);
  if (uniq.length === 0) return {};
  const out: Record<string, NameStyle> = {};
  // Chunked so a long board can't blow past SQLite's variable limit.
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const rows = db
      .prepare(
        `SELECT * FROM player_cosmetics
          WHERE enabled = 1 AND ign_lower IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as CosmeticRow[];
    for (const r of rows) {
      const g = rowToGrant(r);
      if (!isPlainStyle(g.style)) out[g.ignLower] = g.style;
    }
  }
  return out;
}
