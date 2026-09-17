// The three shapes a deposit bot comes in, and so the three trade sizes a
// player can ask for: an empty bot has 8 free slots, one with a backpack 16,
// one with the upgraded 16-slot backpack 24. A deposit is one trade of that
// size — the site never chains a second bot after it. Shared by the form
// and the server.
export const DEPOSIT_SIZES = [8, 16, 24] as const;
export type DepositSize = (typeof DEPOSIT_SIZES)[number];
/** The most any one trade can move: an upgraded-backpack bot's whole inventory. */
export const MAX_TRADE_SLOTS = 24;
export const isDepositSize = (n: number): n is DepositSize => (DEPOSIT_SIZES as readonly number[]).includes(n);
