// My Wishlist: rule parsing, the matcher, feature grants, and the pool scan
// that claims fresh arrivals into a vault.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { linkIgn, userForIgn } from "../users";
import type { PyrelayPool } from "../devauth";
import { featuresOf, grantFeature, listFeatureGrants, revokeFeature, userHasFeature } from "../features";
import { allocateVaultSlots, claimInstances, donateInstances, ownedInstanceIds, vaultCount } from "../vault";
import { createRule, deleteRule, listRules, matchesRule, parseSlotSpecs, scanWishlists, setRuleEnabled, wishRoom, MAX_RULES_PER_USER } from "../wishlist";
import { effectsOfEnchant } from "../enchantEffects";
import { allEnchants, enchantName } from "../enchants";

const T0 = 1_800_000_000_000;
let db: Database.Database;
let userId: number;
beforeEach(() => {
  db = openDatabase(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  userId = userForIgn(db, "Comrade", "comrade");
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// A real enchant that grants HP and one that grants Attack, looked up from
// the catalog so the names used in "ench" terms are the ones the UI offers.
function enchantWith(effect: string, not?: string): number {
  const hit = allEnchants().map((e) => Number(e.realmId)).find((id) => effectsOfEnchant(id).includes(effect) && (!not || !effectsOfEnchant(id).includes(not)));
  if (hit === undefined) throw new Error(`no enchant grants ${effect}`);
  return hit;
}
const HP = enchantWith("+HP");
const ATT = enchantWith("+Attack", "+HP");
const SPD_DOWN = enchantWith("-Speed");

type Term = { kind: "ench"; name: string } | { kind: "effect"; key: string };
/** One slot filter from its "or" rows. */
const slot = (...rows: Term[][]) => ({ any: rows.map((all) => ({ all })) });
const ANY = slot();

function pool(instances: { id: string; itemId: string; ench?: number[]; at?: number; bot?: string }[], botMeta: PyrelayPool["botMeta"] = {}): PyrelayPool {
  const out: PyrelayPool = { ok: true, bots: {}, capacities: {}, instances: {}, botMeta: { "bot-A": { ign: "BotA", server: "USEast", online: true, seasonal: true }, "bot-B": { ign: "BotB", server: "", online: false, seasonal: true }, "bot-N": { ign: "BotN", server: "", online: false, seasonal: false }, "bot-M": { ign: "BotM", server: "", online: false, seasonal: false }, ...botMeta } };
  instances.forEach((i, n) => {
    const bot = i.bot ?? "bot-A";
    out.instances[bot] ??= {};
    out.instances[bot][String(n + 4)] = { instanceId: i.id, itemId: i.itemId, enchantments: i.ench ?? [], capturedAt: i.at ?? T0 + 1 };
    out.bots[bot] ??= {};
    out.bots[bot][i.itemId] = (out.bots[bot][i.itemId] ?? 0) + 1;
  });
  return out;
}

describe("feature grants", () => {
  it("follows the account through every linked character", () => {
    expect(userHasFeature(db, userId, "wishlist")).toBe(false);
    grantFeature(db, "wishlist", "Alt", "alt");
    expect(userHasFeature(db, userId, "wishlist")).toBe(false);
    linkIgn(db, userId, "Alt", "alt");
    expect(featuresOf(db, userId)).toEqual(["wishlist"]);
    expect(listFeatureGrants(db)).toMatchObject([{ feature: "wishlist", ign: "Alt", ignLower: "alt" }]);
    // Re-granting refreshes the casing, never duplicates.
    grantFeature(db, "wishlist", "ALT", "alt");
    expect(listFeatureGrants(db)).toHaveLength(1);
    expect(revokeFeature(db, "wishlist", "alt")).toBe(true);
    expect(revokeFeature(db, "wishlist", "alt")).toBe(false);
    expect(userHasFeature(db, userId, "wishlist")).toBe(false);
  });
});

describe("slot filters", () => {
  it("parses rows, dedupes terms, drops empty rows and trailing open slots, and rejects junk", () => {
    expect(parseSlotSpecs(undefined)).toEqual({ ok: true, specs: [] });
    const r = parseSlotSpecs([
      { any: [{ all: [{ kind: "effect", key: "+HP" }, { kind: "effect", key: "+HP" }] }, { all: [] }, { all: [{ kind: "ench", name: " Attack Bonus III " }] }] },
      { any: [] },
      { any: [] },
    ]);
    expect(r).toEqual({ ok: true, specs: [slot([{ kind: "effect", key: "+HP" }], [{ kind: "ench", name: "Attack Bonus III" }])] });
    // An open slot before a filtered one stays, since it holds a position.
    expect(parseSlotSpecs([{ any: [] }, slot([{ kind: "effect", key: "+HP" }])])).toMatchObject({ ok: true, specs: [ANY, slot([{ kind: "effect", key: "+HP" }])] });
    expect(parseSlotSpecs("no").ok).toBe(false);
    expect(parseSlotSpecs([{ any: "no" }]).ok).toBe(false);
    expect(parseSlotSpecs([slot([{ kind: "effect", key: "HP" }])]).ok).toBe(false);
    expect(parseSlotSpecs([{ any: [{ all: [{ kind: "other" }] }] }]).ok).toBe(false);
    // Two names in one row can't both describe one enchantment.
    expect(parseSlotSpecs([slot([{ kind: "ench", name: "A" }, { kind: "ench", name: "B" }])]).ok).toBe(false);
    expect(parseSlotSpecs([slot(...Array.from({ length: 7 }, () => [{ kind: "effect", key: "+HP" } as Term]))]).ok).toBe(false);
    expect(parseSlotSpecs([ANY, ANY, slot([{ kind: "effect", key: "+HP" }])]).ok).toBe(false);
  });
});

describe("matcher", () => {
  const base = { itemId: "ubatk", slotsMin: 0, slotsExact: null, enchants: [] as ReturnType<typeof slot>[] };
  const hp = { kind: "effect", key: "+HP" } as const;
  const spd = { kind: "effect", key: "-Speed" } as const;
  it("checks the item and the slot count", () => {
    expect(matchesRule(base, "ubatk", [])).toBe(true);
    expect(matchesRule(base, "other", [])).toBe(false);
    expect(matchesRule({ ...base, slotsMin: 2 }, "ubatk", [HP])).toBe(false);
    expect(matchesRule({ ...base, slotsMin: 2 }, "ubatk", [HP, ATT])).toBe(true);
    // Three enchantments can't be traded, so no wish ever fits such an item.
    expect(matchesRule({ ...base, slotsMin: 2 }, "ubatk", [HP, ATT, SPD_DOWN])).toBe(false);
    expect(matchesRule(base, "ubatk", [HP, ATT, SPD_DOWN])).toBe(false);
    expect(matchesRule({ ...base, slotsExact: 1 }, "ubatk", [HP, ATT])).toBe(false);
    expect(matchesRule({ ...base, slotsExact: 1 }, "ubatk", [HP])).toBe(true);
    expect(matchesRule({ ...base, slotsExact: 0 }, "ubatk", [])).toBe(true);
  });
  it("filters each slot on its own, never reusing an enchantment", () => {
    // Slot 1 wants +HP, slot 2 wants -Speed: two different enchantments.
    const two = { ...base, slotsMin: 2, enchants: [slot([hp]), slot([spd])] };
    expect(matchesRule(two, "ubatk", [HP, SPD_DOWN])).toBe(true);
    expect(matchesRule(two, "ubatk", [SPD_DOWN, HP])).toBe(true); // order is not a slot
    expect(matchesRule(two, "ubatk", [HP, ATT])).toBe(false);
    expect(matchesRule(two, "ubatk", [HP, ATT, SPD_DOWN])).toBe(false); // a third enchantment makes it untradable
    // Two slots asking for +HP need two +HP enchantments.
    const twice = { ...base, slotsMin: 2, enchants: [slot([hp]), slot([hp])] };
    expect(matchesRule(twice, "ubatk", [HP, ATT])).toBe(false);
    expect(matchesRule(twice, "ubatk", [HP, HP])).toBe(true);
    // An open slot takes whatever is left.
    const open = { ...base, slotsMin: 2, enchants: [ANY, slot([spd])] };
    expect(matchesRule(open, "ubatk", [SPD_DOWN, HP])).toBe(true);
    expect(matchesRule(open, "ubatk", [HP, ATT])).toBe(false);
  });
  it("ors the rows of one slot, ands the chips of one row, by name or effect", () => {
    const either = { ...base, slotsMin: 1, enchants: [slot([{ kind: "ench", name: enchantName(ATT)! }], [hp])] };
    expect(matchesRule(either, "ubatk", [ATT])).toBe(true);
    expect(matchesRule(either, "ubatk", [HP])).toBe(true);
    expect(matchesRule(either, "ubatk", [SPD_DOWN])).toBe(false);
    expect(matchesRule(either, "ubatk", [])).toBe(false);
    // Both effects on the same enchantment: two separate enchantments don't do.
    const both = { ...base, slotsMin: 1, enchants: [slot([hp, spd])] };
    expect(matchesRule(both, "ubatk", [HP, SPD_DOWN])).toBe(false);
    const tradeoff = allEnchants().map((e) => Number(e.realmId)).find((id) => effectsOfEnchant(id).includes("+HP") && effectsOfEnchant(id).includes("-Speed"));
    if (tradeoff !== undefined) expect(matchesRule(both, "ubatk", [tradeoff])).toBe(true);
  });
});

describe("rules", () => {
  it("creates, lists, toggles and deletes, scoped to the owner", () => {
    const r = createRule(db, userId, { seasonal: true, itemId: "ubatk", slotsMin: 1, enchants: [slot([{ kind: "effect", key: "+HP" }])] });
    expect(r).toMatchObject({ ok: true, rule: { itemId: "ubatk", slotsMin: 1, slotsExact: null, enabled: true } });
    if (!r.ok) throw new Error(r.error);
    expect(listRules(db, userId)).toHaveLength(1);
    const other = userForIgn(db, "Other", "other");
    expect(listRules(db, other)).toEqual([]);
    expect(setRuleEnabled(db, other, r.rule.id, false)).toBeNull();
    expect(setRuleEnabled(db, userId, r.rule.id, false)?.enabled).toBe(false);
    expect(deleteRule(db, other, r.rule.id)).toBe(false);
    expect(deleteRule(db, userId, r.rule.id)).toBe(true);
  });
  it("refuses a missing pool half, unknown items, bad slots, impossible specs, and too many rules", () => {
    expect(createRule(db, userId, { seasonal: undefined, itemId: "ubatk" })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("seasonal or the non-seasonal") });
    expect(createRule(db, userId, { seasonal: "yes", itemId: "ubatk" })).toMatchObject({ ok: false, status: 400 });
    expect(createRule(db, userId, { seasonal: true, itemId: "nope" })).toMatchObject({ ok: false, status: 400 });
    expect(createRule(db, userId, { seasonal: true, itemId: "ubatk", slotsMin: 9 })).toMatchObject({ ok: false, status: 400 });
    expect(createRule(db, userId, { seasonal: true, itemId: "ubatk", slotsMin: 3 })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("can't be traded") });
    expect(createRule(db, userId, { seasonal: true, itemId: "ubatk", slotsExact: 3 })).toMatchObject({ ok: false, status: 400 });
    expect(createRule(db, userId, { seasonal: true, itemId: "ubatk", enchants: [ANY, ANY, slot([{ kind: "effect", key: "+HP" }])] })).toMatchObject({ ok: false, status: 400 });
    expect(createRule(db, userId, { seasonal: true, itemId: "ubatk", slotsExact: 1, enchants: [slot([{ kind: "effect", key: "+HP" }]), slot([{ kind: "effect", key: "+Attack" }])] })).toMatchObject({ ok: false, status: 400 });
    // The minimum rises to cover the filters so the rule can't describe
    // two enchantments while accepting bare items.
    const r = createRule(db, userId, { seasonal: true, itemId: "ubatk", enchants: [slot([{ kind: "effect", key: "+HP" }]), slot([{ kind: "effect", key: "+Attack" }])] });
    expect(r).toMatchObject({ ok: true, rule: { slotsMin: 2 } });
    expect(r.ok && r.rule.enchants).toHaveLength(2);
    db.prepare("UPDATE vault_halves SET slots = 40 WHERE user_id = ? AND seasonal = 1").run(userId);
    for (let i = listRules(db, userId).length; i < MAX_RULES_PER_USER; i++) createRule(db, userId, { seasonal: true, itemId: "ubatk" });
    expect(createRule(db, userId, { seasonal: true, itemId: "ubatk" })).toMatchObject({ ok: false, status: 409 });
  });
  it("caps wishes at their half's free slots, and needs slots there at all", () => {
    db.prepare("UPDATE vault_halves SET slots = 3 WHERE user_id = ? AND seasonal = 1").run(userId);
    claimInstances(db, { userId, ign: "Comrade", ignLower: "comrade" }, [{ instanceId: "held", itemId: "ubatk", enchants: 0, botGuid: "bot-A", seasonal: true }], []);
    expect(wishRoom(db, userId, true)).toEqual({ seasonal: true, slots: 3, used: 1, wishes: 0, free: 2 });
    expect(createRule(db, userId, { seasonal: true, itemId: "ubatk" }).ok).toBe(true);
    expect(createRule(db, userId, { seasonal: true, itemId: "ubvit" }).ok).toBe(true);
    expect(createRule(db, userId, { seasonal: true, itemId: "ubdex" })).toMatchObject({ ok: false, status: 409, error: "Your seasonal vault has 3 slots: 1 item and 2 wishes already fill it." });
    expect(wishRoom(db, userId, true)).toEqual({ seasonal: true, slots: 3, used: 1, wishes: 2, free: 0 });
    // The other half has no slots: no wishes there until some are allocated.
    expect(wishRoom(db, userId, false)).toEqual({ seasonal: false, slots: 0, used: 0, wishes: 0, free: 0 });
    expect(createRule(db, userId, { seasonal: false, itemId: "ubdex" })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("no vault slots allocated to the non-seasonal") });
    // Wishes hold their half's slots against reallocation.
    expect(allocateVaultSlots(db, { userId, ign: "Comrade", ignLower: "comrade" }, true, 0)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("2 wishes") });
  });
});

describe("scan", () => {
  const me = () => ({ userId, ign: "Comrade", ignLower: "comrade" });
  beforeEach(() => {
    grantFeature(db, "wishlist", "Comrade", "comrade");
  });
  it("claims a match into the vault, charges the ledger, and spends the wish", () => {
    const r = createRule(db, userId, { seasonal: true, itemId: "ubatk", enchants: [slot([{ kind: "effect", key: "+HP" }])] });
    if (!r.ok) throw new Error(r.error);
    vi.setSystemTime(T0 + 10_000);
    const p = pool([
      { id: "bare", itemId: "ubatk", ench: [], at: T0 + 5 },
      { id: "hp", itemId: "ubatk", ench: [HP, ATT], at: T0 - 1_000_000 }, // age is no bar
      { id: "wrong", itemId: "ubvit", ench: [HP], at: T0 + 5 },
    ]);
    const res = scanWishlists(db, p);
    expect(res.rules).toBe(1);
    expect(res.hits).toEqual([{ ruleId: r.rule.id, userId, instanceId: "hp", itemId: "ubatk" }]);
    expect(res.skipped).toEqual([]);
    expect(ownedInstanceIds(db)).toEqual(new Set(["hp"]));
    expect(vaultCount(db, userId)).toBe(1);
    expect(listRules(db, userId)).toEqual([]);
    expect(db.prepare("SELECT kind, ign, item_id, enchants FROM transactions").all()).toEqual([{ kind: "withdraw", ign: "Comrade", item_id: "ubatk", enchants: 2 }]);
    expect(db.prepare("SELECT event, instance_id FROM vault_events ORDER BY id").all()).toEqual([
      { event: "claimed", instance_id: "hp" },
      { event: "wishlist", instance_id: "hp" },
    ]);
    // The seasonal half's bot was assigned from the offline, empty seasonal bots.
    expect(db.prepare("SELECT bot_guid FROM vault_halves WHERE user_id = ? AND seasonal = 1").get(userId)).toEqual({ bot_guid: "bot-B" });
    // Nothing is left to serve; donating the item back does not revive the wish.
    expect(scanWishlists(db, p).hits).toEqual([]);
    expect(donateInstances(db, me(), ["hp"]).ok).toBe(true);
    expect(scanWishlists(db, p).hits).toEqual([]);
  });
  it("skips users without the feature, disabled rules, the other pool half, reserved and owned items", () => {
    const other = userForIgn(db, "Other", "other");
    createRule(db, other, { seasonal: true, itemId: "ubatk" }); // no grant
    const mine = createRule(db, userId, { seasonal: true, itemId: "ubatk" });
    if (!mine.ok) throw new Error(mine.error);
    const off = createRule(db, userId, { seasonal: true, itemId: "ubvit" });
    if (!off.ok) throw new Error(off.error);
    setRuleEnabled(db, userId, off.rule.id, false);
    // A reserved item: an open withdraw names it.
    db.prepare(
      "INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at) VALUES ('X','x','USEast','[{\"itemId\":\"ubatk\",\"qty\":1}]','pending','g1','bot-A','[\"held\"]',1,?,?)",
    ).run(T0, T0);
    const p = pool([
      { id: "held", itemId: "ubatk" },
      { id: "nonseasonal", itemId: "ubatk", bot: "bot-N" },
      { id: "vit", itemId: "ubvit" },
      { id: "free", itemId: "ubatk" },
    ]);
    const res = scanWishlists(db, p);
    expect(res.rules).toBe(1);
    expect(res.hits.map((h) => h.instanceId)).toEqual(["free"]);
    expect(vaultCount(db, other)).toBe(0);
  });
  it("follows the wish's pool half, one item per wish, and stops at a full vault", () => {
    expect(allocateVaultSlots(db, me(), true, 0).ok).toBe(true);
    expect(allocateVaultSlots(db, me(), false, 8).ok).toBe(true);
    db.prepare("UPDATE vault_halves SET slots = 2 WHERE user_id = ? AND seasonal = 0").run(userId);
    const a = createRule(db, userId, { seasonal: false, itemId: "ubatk" });
    const b = createRule(db, userId, { seasonal: false, itemId: "ubatk" });
    if (!a.ok || !b.ok) throw new Error("rules");
    // A deposit straight into the vault leaves room for only one of them.
    db.prepare("INSERT INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES ('dep', ?, 'ubvit', 0, 0, 'bot-M', 'deposit', ?)").run(userId, T0);
    const p = pool([
      { id: "s", itemId: "ubatk", bot: "bot-A" },
      { id: "n1", itemId: "ubatk", bot: "bot-N" },
      { id: "n2", itemId: "ubatk", bot: "bot-N" },
    ]);
    const res = scanWishlists(db, p);
    expect(res.hits.map((h) => [h.instanceId, h.ruleId])).toEqual([["n1", a.rule.id]]);
    expect(res.skipped).toEqual([{ ruleId: b.rule.id, instanceId: "n2", why: "vault full" }]);
    expect(listRules(db, userId).map((r) => r.id)).toEqual([b.rule.id]);
    expect(db.prepare("SELECT bot_guid FROM vault_halves WHERE user_id = ? AND seasonal = 0").get(userId)).toEqual({ bot_guid: "bot-M" });
  });
  it("serves the oldest wish first across users, even one made after the item arrived", () => {
    const other = userForIgn(db, "Other", "other");
    grantFeature(db, "wishlist", "Other", "other");
    createRule(db, other, { seasonal: true, itemId: "ubatk", slotsExact: 0 });
    vi.setSystemTime(T0 + 1);
    createRule(db, userId, { seasonal: true, itemId: "ubatk" });
    vi.setSystemTime(T0 + 10);
    // One item: the older wish takes it although the newer one fits too.
    expect(scanWishlists(db, pool([{ id: "only", itemId: "ubatk" }])).hits.map((h) => h.userId)).toEqual([other]);
    // Two items, the older wish already spent: the remaining wish takes one.
    expect(scanWishlists(db, pool([{ id: "one", itemId: "ubatk" }, { id: "two", itemId: "ubatk", ench: [HP] }])).hits.map((h) => [h.instanceId, h.userId])).toEqual([["one", userId]]);
  });
  it("gives an older wish the item nobody else could use, so both are served", () => {
    const other = userForIgn(db, "Other", "other");
    grantFeature(db, "wishlist", "Other", "other");
    const broad = createRule(db, other, { seasonal: true, itemId: "ubatk" }); // any copy will do
    vi.setSystemTime(T0 + 1);
    const narrow = createRule(db, userId, { seasonal: true, itemId: "ubatk", enchants: [slot([{ kind: "effect", key: "+HP" }])] });
    if (!broad.ok || !narrow.ok) throw new Error("rules");
    vi.setSystemTime(T0 + 10);
    const p = pool([{ id: "hp", itemId: "ubatk", ench: [HP] }, { id: "plain", itemId: "ubatk", at: T0 + 2 }]);
    const res = scanWishlists(db, p);
    expect(res.hits.map((h) => [h.instanceId, h.userId])).toEqual([["plain", other], ["hp", userId]]);
  });
  it("leaves alone what a manual claim already took", () => {
    createRule(db, userId, { seasonal: true, itemId: "ubatk" });
    const p = pool([{ id: "one", itemId: "ubatk" }]);
    claimInstances(db, me(), [{ instanceId: "one", itemId: "ubatk", enchants: 0, botGuid: "bot-A", seasonal: true }], []);
    expect(scanWishlists(db, p).hits).toEqual([]);
  });
});

describe("operator view", () => {
  it("lists every account's wishes with its names, access and room, newest wish first", async () => {
    const { listAllWishlists } = await import("../wishlist");
    const other = userForIgn(db, "Other", "other");
    linkIgn(db, other, "OtherAlt", "otheralt");
    grantFeature(db, "wishlist", "Other", "other");
    createRule(db, other, { seasonal: true, itemId: "ubatk" });
    vi.setSystemTime(T0 + 5);
    createRule(db, userId, { seasonal: true, itemId: "ubvit", slotsExact: 1 });
    const all = listAllWishlists(db);
    expect(all.map((p) => p.userId)).toEqual([userId, other]);
    expect(all[0]).toMatchObject({ igns: ["Comrade"], access: false, rules: [{ itemId: "ubvit", slotsExact: 1 }] });
    expect(all[0].room.seasonal).toMatchObject({ slots: 8, used: 0, wishes: 1, free: 7 });
    expect(all[1]).toMatchObject({ igns: ["Other", "OtherAlt"], access: true, rules: [{ itemId: "ubatk", seasonal: true }] });
  });
});
