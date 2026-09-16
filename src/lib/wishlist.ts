import type Database from "better-sqlite3";
import { ITEM_BY_ID } from "./catalog";
import type { PyrelayPool } from "./devauth";
import { effectsOfEnchant } from "./enchantEffects";
import { enchantName } from "./enchants";
import { isPoolBot } from "./capacity";
import { userHasFeature } from "./features";
import { ignsOf } from "./users";
import { claimInstances, ownedInstanceIds, poolName, reservedInstanceIds, vaultBotCandidates, vaultCount, vaultHalf, wishCount, type ClaimPick } from "./vault";

// My Wishlist: standing claims. A rule names a pool half, an item, how many
// enchantment slots it should carry, and a filter per slot — exact names, or
// the "+HP" / "-Speed" effect flags the pool search offers — and every scan
// of the pool moves a fresh arrival that fits into the rule owner's vault in
// that half, paid for exactly like a claim (lib/vault.ts).
//
// Each slot filter is rows of terms: a row fits an enchantment when every
// term describes it (one name at most, plus effects it must have), and any
// one row fitting is enough. So slot 1 = "Attack Bonus III or (+HP and
// -Speed)" is
//   { any: [ { all: [ench Attack Bonus III] }, { all: [+HP, -Speed] } ] }.
// No rows means any enchantment. An item fits when its enchantments can be
// handed out to the slot filters one each, no enchantment used twice — the
// filters are unordered, "Enchantment 1" is just a label.
//
// A rule is one wish: it is deleted the moment it claims, so the item it
// took can be donated without the same wish grabbing it back. Wishes are
// capped by their vault half's free slots, since each one will fill a slot.
//
// Every scan serves wishes oldest first, across all users: each wish in
// turn takes one item it fits from whatever is in the pool, whether the item
// arrived a second or a month ago. Making a wish runs the same scan right
// away, so a new wish gets what is already there — unless an older wish
// fits it too, in which case the older wish is served first.

export const MAX_RULES_PER_USER = 24;
export const MAX_GROUPS = 6;
export const MAX_TERMS_PER_GROUP = 4;
/**
 * Enchantment slots a wish may ask for. An item with more than this many
 * enchantments can't be traded in game, so it can never reach the pool or
 * leave a vault; a wish for one would never be served.
 */
export const MAX_SLOTS = 2;

export type MatchTerm = { kind: "ench"; name: string } | { kind: "effect"; key: string };
/** One slot's filter. Empty `any` accepts any enchantment. */
export type SlotSpec = { any: { all: MatchTerm[] }[] };

export interface WishlistRule {
  id: number;
  userId: number;
  /** Which pool half the wish watches, and which vault it fills. */
  seasonal: boolean;
  itemId: string;
  itemName: string;
  slotsMin: number;
  /** null: "at least slotsMin" enchantments; otherwise exactly this many. */
  slotsExact: number | null;
  /** Per-slot filters; never longer than the slot count the rule allows. */
  enchants: SlotSpec[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RuleResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

type Row = {
  id: number;
  user_id: number;
  seasonal: number;
  item_id: string;
  slots_min: number;
  slots_exact: number | null;
  match_json: string;
  enabled: number;
  hits: number;
  last_hit_at: number | null;
  created_at: number;
  updated_at: number;
};

function toRule(r: Row): WishlistRule {
  let enchants: SlotSpec[] = [];
  try {
    const parsed = parseSlotSpecs((JSON.parse(r.match_json) as { slots?: unknown }).slots);
    if (parsed.ok) enchants = parsed.specs;
  } catch {
    // A corrupt row puts no condition on enchantments; it still shows up so
    // the owner can delete it.
  }
  return {
    id: r.id,
    userId: r.user_id,
    seasonal: r.seasonal !== 0,
    itemId: r.item_id,
    itemName: ITEM_BY_ID.get(r.item_id)?.name ?? r.item_id,
    slotsMin: r.slots_min,
    slotsExact: r.slots_exact,
    enchants,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// --- Spec parsing -----------------------------------------------------------

const EFFECT_KEY = /^[+-][A-Za-z ]{1,32}$/;

function parseSlotSpec(raw: unknown): { ok: true; spec: SlotSpec } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, spec: { any: [] } };
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { any?: unknown }).any)) return { ok: false, error: "Each slot filter must be { any: [{ all: [...] }] }" };
  const rows = (raw as { any: unknown[] }).any;
  if (rows.length > MAX_GROUPS) return { ok: false, error: `At most ${MAX_GROUPS} "or" rows per slot` };
  const any: { all: MatchTerm[] }[] = [];
  for (const g of rows) {
    if (!g || typeof g !== "object" || !Array.isArray((g as { all?: unknown }).all)) return { ok: false, error: "Each row must be { all: [...] }" };
    const terms = (g as { all: unknown[] }).all;
    if (terms.length > MAX_TERMS_PER_GROUP) return { ok: false, error: `At most ${MAX_TERMS_PER_GROUP} conditions per row` };
    const all: MatchTerm[] = [];
    const seen = new Set<string>();
    let names = 0;
    for (const t of terms) {
      if (!t || typeof t !== "object") return { ok: false, error: "Bad condition" };
      const { kind } = t as { kind?: unknown };
      let term: MatchTerm;
      if (kind === "ench") {
        const name = (t as { name?: unknown }).name;
        if (typeof name !== "string" || !name.trim() || name.length > 64) return { ok: false, error: "Enchantment condition needs a name" };
        term = { kind: "ench", name: name.trim() };
      } else if (kind === "effect") {
        const key = (t as { key?: unknown }).key;
        if (typeof key !== "string" || !EFFECT_KEY.test(key)) return { ok: false, error: "Effect condition needs a key like \"+HP\"" };
        term = { kind: "effect", key };
      } else {
        return { ok: false, error: "Condition kind must be ench or effect" };
      }
      const k = term.kind === "ench" ? `ench:${term.name}` : `effect:${term.key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (term.kind === "ench" && ++names > 1) return { ok: false, error: "A row describes one enchantment — one name per row; add an \"or\" row for another." };
      all.push(term);
    }
    // An empty row would accept any enchantment, which is never what a row
    // of chips meant; drop it rather than let it swallow the other rows.
    if (all.length) any.push({ all });
  }
  return { ok: true, spec: { any } };
}

/**
 * The per-slot filters of a rule. Trailing filters with no rows say nothing
 * the slot count doesn't already, so they are trimmed.
 */
export function parseSlotSpecs(raw: unknown): { ok: true; specs: SlotSpec[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, specs: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "enchants must be a list of slot filters" };
  if (raw.length > 16) return { ok: false, error: "Too many slot filters" };
  const specs: SlotSpec[] = [];
  for (const r of raw) {
    const p = parseSlotSpec(r);
    if (!p.ok) return p;
    specs.push(p.spec);
  }
  while (specs.length && !specs[specs.length - 1].any.length) specs.pop();
  if (specs.length > MAX_SLOTS) return { ok: false, error: `At most ${MAX_SLOTS} enchantment slots — items with more can't be traded.` };
  return { ok: true, specs };
}

export type RuleInput = {
  /** Required: the pool half the wish is for. */
  seasonal: unknown;
  itemId: unknown;
  slotsMin?: unknown;
  slotsExact?: unknown;
  enchants?: unknown;
};

function parseSlots(v: unknown, what: string): { ok: true; n: number | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, n: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SLOTS) return { ok: false, error: `${what} must be 0-${MAX_SLOTS}: items with more enchantments can't be traded.` };
  return { ok: true, n };
}

// --- Matching ---------------------------------------------------------------

export type RuleShape = Pick<WishlistRule, "itemId" | "slotsMin" | "slotsExact" | "enchants">;

/** Does one enchantment satisfy a term? */
export function termMatches(term: MatchTerm, enchantId: number): boolean {
  if (term.kind === "ench") return (enchantName(enchantId) ?? `Enchant #${enchantId}`) === term.name;
  return effectsOfEnchant(enchantId).includes(term.key);
}

/** Does one enchantment pass a slot filter? */
export function enchantFits(spec: SlotSpec, enchantId: number): boolean {
  return !spec.any.length || spec.any.some((row) => row.all.every((t) => termMatches(t, enchantId)));
}

/** Does an item of `itemId` carrying `enchantIds` satisfy the rule? */
export function matchesRule(rule: RuleShape, itemId: string, enchantIds: number[]): boolean {
  if (rule.itemId !== itemId) return false;
  const n = enchantIds.length;
  // Never an untradable item, however open the wish.
  if (n > MAX_SLOTS) return false;
  if (rule.slotsExact !== null ? n !== rule.slotsExact : n < rule.slotsMin) return false;
  const specs = rule.enchants;
  if (specs.length > n) return false;
  // Hand the item's enchantments to the filters one each, no enchantment
  // twice. At most four of either, so a plain search is fine.
  const fits = specs.map((spec) => enchantIds.map((id) => enchantFits(spec, id)));
  const used: boolean[] = new Array(n).fill(false);
  const assign = (i: number): boolean => {
    if (i === specs.length) return true;
    for (let j = 0; j < n; j++) {
      if (used[j] || !fits[i][j]) continue;
      used[j] = true;
      if (assign(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return assign(0);
}

// --- Rule CRUD --------------------------------------------------------------

export interface WishRoom {
  seasonal: boolean;
  slots: number;
  used: number;
  wishes: number;
  free: number;
}

/** How one vault half's slots are spoken for: items held, wishes pending, and what is left for a new wish. */
export function wishRoom(db: Database.Database, userId: number, seasonal: boolean): WishRoom {
  const slots = vaultHalf(db, userId, seasonal).slots;
  const used = vaultCount(db, userId, seasonal);
  const wishes = wishCount(db, userId, seasonal);
  return { seasonal, slots, used, wishes, free: Math.max(0, slots - used - wishes) };
}

/** One player's wishes as the operator sees them: every linked name, room in each half, the wishes themselves. */
export interface PlayerWishlist {
  userId: number;
  igns: string[];
  /** The account currently holds the wishlist feature (a lapsed grant leaves its wishes dormant). */
  access: boolean;
  room: { seasonal: WishRoom; nonseasonal: WishRoom };
  rules: WishlistRule[];
}

/** Every account with at least one wish, most recent wish first. For the dev console. */
export function listAllWishlists(db: Database.Database): PlayerWishlist[] {
  const rows = db.prepare("SELECT * FROM wishlist_rules ORDER BY user_id, id").all() as Row[];
  const byUser = new Map<number, WishlistRule[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(toRule(r));
    byUser.set(r.user_id, list);
  }
  const out: PlayerWishlist[] = [];
  for (const [userId, rules] of byUser) {
    out.push({
      userId,
      igns: ignsOf(db, userId).map((i) => i.ign),
      access: userHasFeature(db, userId, "wishlist"),
      room: { seasonal: wishRoom(db, userId, true), nonseasonal: wishRoom(db, userId, false) },
      rules,
    });
  }
  out.sort((a, b) => Math.max(...b.rules.map((r) => r.createdAt)) - Math.max(...a.rules.map((r) => r.createdAt)));
  return out;
}

export function listRules(db: Database.Database, userId: number): WishlistRule[] {
  return (db.prepare("SELECT * FROM wishlist_rules WHERE user_id = ? ORDER BY id").all(userId) as Row[]).map(toRule);
}

export function createRule(db: Database.Database, userId: number, input: RuleInput, now = Date.now()): RuleResult<{ rule: WishlistRule }> {
  if (typeof input.seasonal !== "boolean") return { ok: false, status: 400, error: "Say whether the wish is for the seasonal or the non-seasonal pool." };
  const seasonal = input.seasonal;
  const itemId = typeof input.itemId === "string" ? input.itemId : "";
  if (!ITEM_BY_ID.has(itemId)) return { ok: false, status: 400, error: "Pick an item the pool accepts." };
  const min = parseSlots(input.slotsMin, "Minimum slots");
  if (!min.ok) return { ok: false, status: 400, error: min.error };
  const exact = parseSlots(input.slotsExact, "Exact slots");
  if (!exact.ok) return { ok: false, status: 400, error: exact.error };
  const specs = parseSlotSpecs(input.enchants);
  if (!specs.ok) return { ok: false, status: 400, error: specs.error };
  // More filters than the rule allows slots can never match; under "at
  // least", the minimum rises to cover them instead.
  const need = specs.specs.length;
  if (exact.n !== null && need > exact.n) return { ok: false, status: 400, error: `${need} enchantments are described but the rule allows exactly ${exact.n} slot${exact.n === 1 ? "" : "s"}.` };
  const count = (db.prepare("SELECT COUNT(*) AS n FROM wishlist_rules WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= MAX_RULES_PER_USER) return { ok: false, status: 409, error: `At most ${MAX_RULES_PER_USER} wishes.` };
  // Every wish will fill a slot of its vault half, so items held plus
  // wishes there can't exceed the half.
  const room = wishRoom(db, userId, seasonal);
  if (room.slots <= 0) return { ok: false, status: 409, error: `You have no vault slots allocated to the ${poolName(seasonal)} pool. Allocate some from My Vault first.` };
  if (room.free <= 0) return { ok: false, status: 409, error: `Your ${poolName(seasonal)} vault has ${room.slots} slot${room.slots === 1 ? "" : "s"}: ${room.used} item${room.used === 1 ? "" : "s"} and ${room.wishes} wish${room.wishes === 1 ? "" : "es"} already fill it.` };
  const slotsMin = exact.n !== null ? exact.n : Math.max(min.n ?? 0, need);
  const id = Number(
    db
      .prepare("INSERT INTO wishlist_rules (user_id, seasonal, item_id, slots_min, slots_exact, match_json, enabled, hits, last_hit_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)")
      .run(userId, seasonal ? 1 : 0, itemId, slotsMin, exact.n, JSON.stringify({ slots: specs.specs }), now, now).lastInsertRowid,
  );
  return { ok: true, rule: toRule(db.prepare("SELECT * FROM wishlist_rules WHERE id = ?").get(id) as Row) };
}

export function setRuleEnabled(db: Database.Database, userId: number, id: number, enabled: boolean, now = Date.now()): WishlistRule | null {
  db.prepare("UPDATE wishlist_rules SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(enabled ? 1 : 0, now, id, userId);
  const row = db.prepare("SELECT * FROM wishlist_rules WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  return row ? toRule(row) : null;
}

export function deleteRule(db: Database.Database, userId: number, id: number): boolean {
  return db.prepare("DELETE FROM wishlist_rules WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

// --- Scanning ---------------------------------------------------------------

export interface ScanHit {
  ruleId: number;
  userId: number;
  instanceId: string;
  itemId: string;
}

export interface ScanResult {
  /** Rules considered (enabled, owner still holds the feature). */
  rules: number;
  hits: ScanHit[];
  /** Wishes that fit an item but could not take it: a full vault, a rate limit, a lost race. */
  skipped: { ruleId: number; instanceId: string; why: string }[];
}

type Visible = { instanceId: string; itemId: string; enchantments: number[]; capturedAt: number; botGuid: string; seasonal: boolean };

/**
 * Serve every enabled wish, oldest first, from the pool payload.
 *
 * A wish takes the matching item that the fewest other wishes could use
 * (earliest capture breaking ties), so an older wish that would be happy
 * with either of two items leaves the contested one for the newer wish
 * that can only use that one. Claims go one item at a time so a refusal
 * (a rate limit, a race with a manual claim) costs that wish or item alone.
 */
export function scanWishlists(db: Database.Database, pool: PyrelayPool, now = Date.now()): ScanResult {
  const out: ScanResult = { rules: 0, hits: [], skipped: [] };
  const rows = db.prepare("SELECT * FROM wishlist_rules WHERE enabled = 1 ORDER BY created_at, id").all() as Row[];
  if (!rows.length) return out;
  const owned = ownedInstanceIds(db);
  const reserved = reservedInstanceIds(db);
  const meta = pool.botMeta ?? {};
  const visible: Visible[] = [];
  for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
    const seasonal = isPoolBot(meta[botGuid], true);
    for (const info of Object.values(slots)) {
      if (owned.has(info.instanceId) || reserved.has(info.instanceId)) continue;
      visible.push({ instanceId: info.instanceId, itemId: info.itemId, enchantments: info.enchantments ?? [], capturedAt: info.capturedAt ?? 0, botGuid, seasonal });
    }
  }
  visible.sort((a, b) => a.capturedAt - b.capturedAt || a.instanceId.localeCompare(b.instanceId));

  const access = new Map<number, boolean>();
  const hasAccess = (userId: number) => {
    let v = access.get(userId);
    if (v === undefined) {
      v = userHasFeature(db, userId, "wishlist");
      access.set(userId, v);
    }
    return v;
  };
  const rules = rows.map(toRule).filter((r) => hasAccess(r.userId));
  out.rules = rules.length;
  if (!rules.length || !visible.length) return out;

  // Which items each wish fits, within its pool half; and how many wishes
  // fit each item, for the least-contested pick.
  const fits = rules.map((rule) => {
    const idx: number[] = [];
    visible.forEach((inst, i) => {
      if (inst.seasonal === rule.seasonal && matchesRule(rule, inst.itemId, inst.enchantments)) idx.push(i);
    });
    return idx;
  });
  const wanted: number[] = new Array(visible.length).fill(0);
  for (const idx of fits) for (const i of idx) wanted[i]++;

  const taken = new Set<number>();
  // Free slots per vault half, keyed "user:seasonal".
  const room = new Map<string, number>();
  const actorOf = new Map<number, { userId: number; ign: string; ignLower: string } | null>();
  const drop = db.prepare("DELETE FROM wishlist_rules WHERE id = ?");
  const ev = db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) VALUES (?, ?, 'wishlist', ?, ?, ?, ?)");

  rules.forEach((rule, r) => {
    const candidates = fits[r].filter((i) => !taken.has(i)).sort((a, b) => wanted[a] - wanted[b] || a - b);
    if (!candidates.length) return;
    const halfKey = `${rule.userId}:${rule.seasonal ? 1 : 0}`;
    let left = room.get(halfKey);
    if (left === undefined) {
      left = vaultHalf(db, rule.userId, rule.seasonal).slots - vaultCount(db, rule.userId, rule.seasonal);
      room.set(halfKey, left);
    }
    if (left <= 0) {
      out.skipped.push({ ruleId: rule.id, instanceId: visible[candidates[0]].instanceId, why: "vault full" });
      return;
    }
    let actor = actorOf.get(rule.userId);
    if (actor === undefined) {
      const ign = ignsOf(db, rule.userId)[0];
      actor = ign ? { userId: rule.userId, ign: ign.ign, ignLower: ign.ignLower } : null;
      actorOf.set(rule.userId, actor);
    }
    if (!actor) return;
    for (const i of candidates) {
      const inst = visible[i];
      const pick: ClaimPick = { instanceId: inst.instanceId, itemId: inst.itemId, enchants: inst.enchantments.length, botGuid: inst.botGuid, seasonal: inst.seasonal };
      const res = claimInstances(db, actor, [pick], vaultBotCandidates(db, pool, inst.seasonal, rule.userId));
      if (res.ok) {
        taken.add(i);
        room.set(halfKey, left - 1);
        // One wish, one item: the rule is spent.
        drop.run(rule.id);
        ev.run(rule.userId, actor.ign, inst.instanceId, inst.itemId, JSON.stringify({ ruleId: rule.id, enchants: inst.enchantments.length, from: inst.botGuid }), now);
        out.hits.push({ ruleId: rule.id, userId: rule.userId, instanceId: inst.instanceId, itemId: inst.itemId });
        return;
      }
      out.skipped.push({ ruleId: rule.id, instanceId: inst.instanceId, why: res.error });
      // A rate limit or a full vault won't clear within this scan; a lost
      // race for one item says nothing about the next.
      if (res.status === 429 || /Not enough room|no vault slots/.test(res.error)) {
        room.set(halfKey, 0);
        return;
      }
    }
  });
  return out;
}

export function anyRulesEnabled(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM wishlist_rules WHERE enabled = 1 LIMIT 1").get();
}
