// How big a deposit can be. A deposit is one trade of as many items as the
// player says they bring, from 1 up to what one bot can take: an empty bot
// has 8 free slots, one with a backpack 16, one with the upgraded backpack
// 24. Under advanced management (docs/relay/ADVANCED.md) only an empty bot
// takes a deposit, and one bigger than that bot holds continues with the
// next empty bot (lib/queue.ts fulfillDeposit), up to the same 24 in all;
// otherwise no second bot follows. Shared by the form and the server.
/** The most any one trade can move: an upgraded-backpack bot's whole inventory. */
export const MAX_TRADE_SLOTS = 24;
export const isDepositSize = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_TRADE_SLOTS;
