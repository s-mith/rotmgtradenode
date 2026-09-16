// Missions: what a player has to contribute to earn a skin redemption.
// Shared by the site (progress and redeem checks) and the Vault (the panel),
// so both agree on what "earned" means. Progress itself is not stored — it is
// computed per player from the transactions ledger, NET (deposits earn,
// withdrawals subtract), so a deposit→withdraw→redeposit wash can't inflate it.
export type MissionStat = "seasonalPotionsNet";

export type MissionDef = {
  id: string;
  title: string;
  desc: string;
  target: number;
  unit: string;
  statKey: MissionStat;
  /** Milestone missions grant one redemption per `rewardEvery` units, up to `target`. */
  rewardEvery?: number;
};

export const MISSION_DEFS: MissionDef[] = [
  {
    id: "seasonal-pots",
    title: "Seasonal Potion Drive",
    desc: "Contribute 3,000 net stat points of seasonal potions (greaters count double) to redeem a skin. Withdrawals count against it.",
    target: 3000,
    unit: "net stat points",
    statKey: "seasonalPotionsNet",
  },
];

/** Redemptions a mission has earned at `current` progress (negative progress earns nothing). */
export function earnedRewards(m: MissionDef, current: number): number {
  if (current <= 0) return 0;
  if (m.rewardEvery) return Math.floor(Math.min(current, m.target) / m.rewardEvery);
  return current >= m.target ? 1 : 0;
}
export function maxRewards(m: MissionDef): number {
  return m.rewardEvery ? Math.floor(m.target / m.rewardEvery) : 1;
}
/** Redemptions earned across every mission. */
export function totalEarned(stats: Record<MissionStat, number>): number {
  return MISSION_DEFS.reduce((n, m) => n + earnedRewards(m, stats[m.statKey] ?? 0), 0);
}
