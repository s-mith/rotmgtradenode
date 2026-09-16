// Bulk stat-potion withdraws: turn "I need N points of attack" into a concrete
// list of potions to pull from the pool.
//
// In game a normal potion grants 1 point of its stat and a greater grants 2.
// Players maxing a stat think in points ("I'm 23 off max"), not in items, and
// picking 23 individual potions out of a grid is miserable — hence this mode.
//
// Fill policy: pack one bot at a time. Bots are ordered by how many points they
// can contribute, and each is drained as far as the request needs before moving
// to the next. What costs the player time is the number of TRADES, not the
// number of potions, so taking everything one bot can give beats spreading the
// same items across three bots.
//
// Greaters still go first *within* a bot, because a trade window holds a fixed
// number of items — filling those slots with 2-point potions is what maximises
// what a single trade delivers. The change from the earlier policy is the
// ordering across the pool, not within a bot.

export const POTION_STATS = [
  "atk", "def", "spd", "vit", "wis", "dex", "life", "mana",
] as const;

export type PotionStat = (typeof POTION_STATS)[number];

// stat -> the catalog ids for its normal and greater potion.
export const POTION_IDS: Record<PotionStat, { normal: string; greater: string }> = {
  atk: { normal: "patk", greater: "gpatk" },
  def: { normal: "pdef", greater: "gpdef" },
  spd: { normal: "pspd", greater: "gpspd" },
  vit: { normal: "pvit", greater: "gpvit" },
  wis: { normal: "pwis", greater: "gpwis" },
  dex: { normal: "pdex", greater: "gpdex" },
  life: { normal: "plife", greater: "gplife" },
  mana: { normal: "pmana", greater: "gpmana" },
};

export const STAT_LABELS: Record<PotionStat, string> = {
  atk: "Attack",
  def: "Defense",
  spd: "Speed",
  vit: "Vitality",
  wis: "Wisdom",
  dex: "Dexterity",
  life: "Life",
  mana: "Mana",
};

export function isPotionStat(v: unknown): v is PotionStat {
  return typeof v === "string" && (POTION_STATS as readonly string[]).includes(v);
}

export type PotionFill = {
  /** itemId -> qty to withdraw. */
  items: Record<string, number>;
  /** Stat points these potions actually grant. */
  pointsFilled: number;
  /** Points the pool couldn't cover (0 when fully satisfied). */
  shortfall: number;
  /**
   * Points granted beyond what was asked for. Only ever 1, and only when an
   * odd request has to be topped off with a greater because no normal potion
   * is available. The extra point is wasted in game once the stat caps, so the
   * UI should say so rather than quietly hand over one more potion.
   */
  overshoot: number;
};

/**
 * Choose potions covering `points` of one stat from what the pool actually has.
 *
 * availNormal / availGreater are item counts currently withdrawable.
 */
export function planPotionFill(
  points: number,
  availNormal: number,
  availGreater: number,
  ids: { normal: string; greater: string },
): PotionFill {
  const want = Math.max(0, Math.floor(points));
  const normalStock = Math.max(0, Math.floor(availNormal));
  const greaterStock = Math.max(0, Math.floor(availGreater));
  const items: Record<string, number> = {};
  if (want === 0) {
    return { items, pointsFilled: 0, shortfall: 0, overshoot: 0 };
  }

  // Greaters first, but never more than cover the request: an even request is
  // all greaters, an odd one leaves exactly 1 point for a normal.
  let greaters = Math.min(greaterStock, Math.floor(want / 2));
  let filled = greaters * 2;

  // Normals cover the remainder — which is 1 point on an odd request, or more
  // when greaters ran out first.
  const normals = Math.min(normalStock, want - filled);
  filled += normals;

  // Still short by exactly 1 with greaters left over: that only happens on an
  // odd request with no normals in stock. One more greater completes the max
  // and wastes a single point — better than leaving the player 1 short.
  let overshoot = 0;
  if (want - filled === 1 && greaters < greaterStock) {
    greaters += 1;
    filled += 2;
    overshoot = 1;
  }

  if (greaters > 0) items[ids.greater] = greaters;
  if (normals > 0) items[ids.normal] = normals;

  return {
    items,
    pointsFilled: filled,
    shortfall: Math.max(0, want - filled),
    overshoot,
  };
}


// Items one bot can hand over in a single trade window. Realm's trade UI
// exposes 8 slots, so a bot holding more than that needs a second trade — which
// is a second row targeting the same bot, not a reason to involve another one.
export const MAX_ITEMS_PER_TRADE = 8;

/** What one bot can contribute to a potion withdraw, post-reservation. */
export type BotStock = { botGuid: string; normal: number; greater: number };

/** One trade: `botGuid` hands over `items`. */
export type PotionFragment = { botGuid: string; items: Record<string, number> };

export type PotionWithdrawPlan = PotionFill & { fragments: PotionFragment[] };

/**
 * Choose potions covering `points`, packing each bot as full as the request
 * allows before moving to the next.
 *
 * Bots are visited in descending order of the points they can supply, so the
 * fewest bots are involved; ties break on botGuid so a resubmit against
 * unchanged stock produces an identical plan. A bot holding more than one
 * trade's worth gets several fragments — sequential trades with the same bot,
 * still cheaper for the player than pulling in another one.
 */
export function planPotionWithdraw(
  points: number,
  bots: BotStock[],
  ids: { normal: string; greater: string },
  maxItemsPerTrade: number = MAX_ITEMS_PER_TRADE,
): PotionWithdrawPlan {
  let need = Math.max(0, Math.floor(points));
  const fragments: PotionFragment[] = [];
  const totals: Record<string, number> = {};

  // Working copies so we can spend stock as we allocate.
  const stock = bots
    .map((b) => ({
      botGuid: b.botGuid,
      normal: Math.max(0, Math.floor(b.normal)),
      greater: Math.max(0, Math.floor(b.greater)),
    }))
    .filter((b) => b.normal + b.greater > 0);
  stock.sort(
    (a, b) =>
      b.greater * 2 + b.normal - (a.greater * 2 + a.normal) ||
      a.botGuid.localeCompare(b.botGuid),
  );

  const record = (bot: { botGuid: string }, greaters: number, normals: number) => {
    const items: Record<string, number> = {};
    if (greaters > 0) items[ids.greater] = greaters;
    if (normals > 0) items[ids.normal] = normals;
    fragments.push({ botGuid: bot.botGuid, items });
    if (greaters > 0) totals[ids.greater] = (totals[ids.greater] ?? 0) + greaters;
    if (normals > 0) totals[ids.normal] = (totals[ids.normal] ?? 0) + normals;
  };

  for (const bot of stock) {
    // Keep pulling trade-sized chunks from this bot until it's spent or the
    // request is satisfied — only then consider the next bot.
    while (need > 0 && bot.normal + bot.greater > 0) {
      const greaters = Math.min(bot.greater, Math.floor(need / 2), maxItemsPerTrade);
      const afterGreaters = need - greaters * 2;
      const normals = Math.min(bot.normal, afterGreaters, maxItemsPerTrade - greaters);
      if (greaters === 0 && normals === 0) break; // can't help with what's left
      record(bot, greaters, normals);
      bot.greater -= greaters;
      bot.normal -= normals;
      need -= greaters * 2 + normals;
    }
    if (need <= 0) break;
  }

  // Short by exactly one point with a greater still out there: spend it and
  // waste the extra point rather than leave the player one off max. Prefer a
  // bot we're already trading with, so this never adds a trade.
  let overshoot = 0;
  if (need === 1) {
    const donor =
      stock.find((b) => b.greater > 0 && fragments.some((f) => f.botGuid === b.botGuid)) ??
      stock.find((b) => b.greater > 0);
    if (donor) {
      const existing = fragments.find(
        (f) =>
          f.botGuid === donor.botGuid &&
          Object.values(f.items).reduce((a, c) => a + c, 0) < maxItemsPerTrade,
      );
      if (existing) {
        existing.items[ids.greater] = (existing.items[ids.greater] ?? 0) + 1;
      } else {
        fragments.push({ botGuid: donor.botGuid, items: { [ids.greater]: 1 } });
      }
      totals[ids.greater] = (totals[ids.greater] ?? 0) + 1;
      donor.greater -= 1;
      need -= 2;
      overshoot = 1;
    }
  }

  // Derive the total from what's actually in the fragments rather than from
  // the remaining need: an overshoot drives `need` negative, and clamping that
  // at zero would under-report the points the player is about to receive.
  const requested = Math.max(0, Math.floor(points));
  const pointsFilled =
    (totals[ids.greater] ?? 0) * 2 + (totals[ids.normal] ?? 0);
  return {
    fragments,
    items: totals,
    pointsFilled,
    shortfall: Math.max(0, requested - pointsFilled),
    overshoot,
  };
}
