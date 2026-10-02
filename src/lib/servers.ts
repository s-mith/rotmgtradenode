export const SERVERS = [
  "USWest4",
  "USWest3",
  "USWest",
  "USSouthWest",
  "USSouth3",
  "USSouth",
  "USNorthWest",
  "USMidWest2",
  "USMidWest",
  "USEast",
  "USEast2",
  "EUWest2",
  "EUWest",
  "EUSouthWest",
  "EUNorth",
  "EUEast",
  "Asia",
  "Australia",
] as const;

export type Server = (typeof SERVERS)[number];

export const SERVER_SET: Set<string> = new Set(SERVERS);

// No servers are hardcoded as deposit-only anymore — per-server controls
// in the dev console handle disabling deposits or withdraws dynamically.
export const DEPOSIT_ONLY_SERVERS: Set<string> = new Set();

/** Servers a withdraw may target. */
export const WITHDRAW_SERVERS: readonly string[] = SERVERS.filter(
  (s) => !DEPOSIT_ONLY_SERVERS.has(s),
);

export function isDepositOnly(server: string): boolean {
  return DEPOSIT_ONLY_SERVERS.has(server);
}
