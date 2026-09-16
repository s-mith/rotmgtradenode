// The two shapes a deposit bot comes in, and so the two trade sizes a
// player can ask for: an empty bot has 8 free slots, an empty bot with a
// backpack has 16. A deposit is one trade of that size — the site never
// chains a second bot after it. Shared by the form and the server.
export const DEPOSIT_SIZES = [8, 16] as const;
export type DepositSize = (typeof DEPOSIT_SIZES)[number];
/** The most any one trade can move: a backpack bot's whole inventory. */
export const MAX_TRADE_SLOTS = 16;
export const isDepositSize = (n: number): n is DepositSize => (DEPOSIT_SIZES as readonly number[]).includes(n);
