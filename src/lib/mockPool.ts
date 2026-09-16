// The dev-only fixture pool behind POOL_MOCK=1: what the pool page, the
// vault and the trade routes see when no fleet is running locally. Never
// served in production (the callers check NODE_ENV as well).
import { CATALOG } from "./catalog";
import type { PyrelayPool } from "./devauth";

let mock: PyrelayPool | null = null;

/** Forget the cached fixture (tests). */
export function resetMockPool(): void {
  mock = null;
}

/**
 * Test-only pool, gated behind POOL_MOCK=1 so it never serves in prod. Seeds a
 * spread of real catalog items (rings, every T6 ability, weapons, armor, and a
 * batch of UT/ST so dismantle values show) with a few enchanted copies so class
 * filtering, rarity and tooltips are visible without a live fleet.
 */
export function mockPool(): PyrelayPool {
  if (mock) return mock;
  const utst = CATALOG.filter((c) => c.category === "UT/ST").slice(0, 60);
  // Ensure the lone Legendary-material item is present so that slider is testable.
  const fa = CATALOG.filter((c) => c.name === "Forbidden Artifact" && !utst.includes(c));
  const picks = [...CATALOG.slice(0, 60), ...utst, ...fa];
  const servers = ["USEast", "USWest", "EUWest", ""];
  const instances: PyrelayPool["instances"] = {};
  const bots: PyrelayPool["bots"] = {};
  const botMeta: NonNullable<PyrelayPool["botMeta"]> = {};
  const nextSlot: Record<string, number> = {};
  picks.forEach((c, i) => {
    const bot = `mockbot-${i % 4}`;
    botMeta[bot] ??= { ign: `MockBot${i % 4}`, server: servers[i % servers.length], online: servers[i % servers.length] !== "", seasonal: true };
    const copies = (i % 3) + 1; // 1–3 copies per item
    for (let k = 0; k < copies; k++) {
      // Every other copy is enchanted; copies of one item get DIFFERENT enchant
      // sets at the same count so the "stack by rarity & type" checkbox has
      // visibly separate tiles to merge.
      const enchCount = i % 2 === 0 ? 1 + (k % 2) : 0;
      const enchantments = Array.from({ length: enchCount }, (_, e) => e + 1 + k * 3);
      const slot = (nextSlot[bot] = (nextSlot[bot] ?? 4) + 1);
      (instances[bot] ??= {})[String(slot)] = { instanceId: `mock-${c.id}-${k}`, itemId: c.id, enchantments, capturedAt: 0 };
      (bots[bot] ??= {})[c.id] = ((bots[bot] ?? {})[c.id] ?? 0) + 1;
    }
  });
  // Two empty bots asleep in the pool, so a deposit has somewhere to go: a
  // plain one (8 slots) and one with a backpack (16), the two trade sizes.
  botMeta["mockbot-empty8"] = { ign: "MockEmpty", server: "", online: false, seasonal: true };
  botMeta["mockbot-empty16"] = { ign: "MockPack", server: "", online: false, seasonal: true };
  // The holders carry far more than a real inventory; give each a capacity
  // equal to its load so the capacity maths read as a full-but-consistent
  // pool with exactly the two empty bots free.
  const capacities: Record<string, number> = { "mockbot-empty16": 16 };
  for (const [g, inv] of Object.entries(bots)) capacities[g] = Object.values(inv).reduce((a, b) => a + b, 0);
  mock = { ok: true, bots, capacities, instances, botMeta };
  return mock;
}
