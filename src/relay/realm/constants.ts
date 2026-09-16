// Realm constants the bots need. Server IPs move occasionally; they come
// from the account/servers endpoint and are pinned here like pyrelay did.
export const GAME_PORT = 2050;

export const GameId = {
  tutorial: -1,
  nexus: -2,
  randomRealm: -3,
  vault: -5,
} as const;

export const ClassId = {
  ROGUE: 768, ARCHER: 775, WIZARD: 782, PRIEST: 784, WARRIOR: 797, KNIGHT: 798, PALADIN: 799,
  ASSASSIN: 800, NECROMANCER: 801, HUNTRESS: 802, MYSTIC: 803, TRICKSTER: 804, SORCERER: 805,
  NINJA: 806, SAMURAI: 785, BARD: 796, SUMMONER: 817, KENSEI: 818,
} as const;

export const Condition = {
  SLOWED: 4, DAZED: 6, STUNNED: 7, PARALYZED: 14, SPEEDY: 15, BERSERK: 20, PAUSED: 21,
  NINJASPEEDY: 29, PETRIFIED: 35,
} as const;

export function hasCondition(bits: number, ...effects: number[]): boolean {
  let mask = 0;
  for (const e of effects) mask |= 1 << (e - 1);
  return (bits & mask) !== 0;
}

export const SERVER_IPS: Record<string, string> = {
  EUEast: "18.184.218.174", EUSouthWest: "35.180.67.120", USEast2: "54.209.152.223",
  EUNorth: "18.159.133.120", USEast: "54.234.226.24", USWest4: "54.235.235.140",
  EUWest2: "52.16.86.215", Asia: "3.0.147.127", USSouth3: "52.207.206.31", EUWest: "15.237.60.223",
  USWest: "54.86.47.176", USMidWest2: "3.140.254.133", USMidWest: "18.221.120.59",
  USSouth: "3.82.126.16", USWest3: "18.144.30.153", USSouthWest: "54.153.13.68",
  USNorthWest: "34.238.176.119", Australia: "13.236.87.250",
};
export const SERVER_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SERVER_IPS).map(([n, ip]) => [ip, n]),
);
export function isServerName(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVER_IPS, s);
}
export const DEFAULT_SERVER = "USSouth3";

export const REALM_API = {
  VERIFY: "https://www.realmofthemadgod.com/account/verify",
  VERIFY_TOKEN: "https://www.realmofthemadgod.com/account/verifyAccessTokenClient",
  CHAR_LIST: "https://www.realmofthemadgod.com/char/list",
  SERVERS: "https://www.realmofthemadgod.com/account/servers",
  CHAR_DELETE: "https://www.realmofthemadgod.com/char/delete",
  /** Daily-login calendar (one item per day, claim key on reached+unclaimed days). accessToken alone is enough. */
  CALENDAR: "https://www.realmofthemadgod.com/dailyLogin/fetchCalendar",
  /** JSON {id, name, start, end, ...}: the season clock (endpoint name from the client's string table, 2026-09-07). */
  SEASON_INFO: "https://www.realmofthemadgod.com/season/seasonInfo",
} as const;
export const REALM_HEADERS = {
  "User-Agent": "UnityPlayer/2021.3.16f1 (UnityWebRequest/1.0, libcurl/7.84.0-DEV)",
  "X-Unity-Version": "2021.3.16f1",
} as const;
