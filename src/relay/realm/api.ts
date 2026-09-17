// Realm's account HTTP API: the three calls that stand between an account
// and a game socket. Every call goes out through the account's proxy so the
// token is minted from the same exit IP the game socket will use — Realm
// treats a mismatch as the token-security signal.
import https from "node:https";
import { createHash } from "node:crypto";
import { SocksProxyAgent } from "socks-proxy-agent";
import { REALM_API, REALM_HEADERS } from "./constants";
import { proxyUrl, type Proxy } from "../net/proxy";

export const AUTH_TIMEOUT_MS = Number(process.env.REALM_AUTH_TIMEOUT_SECONDS ?? 45) * 1000;

const COMMON_FORM = { game_net: "Unity", play_platform: "Unity", game_net_user_id: "" };

export type AuthFailure =
  | { kind: "network"; detail: string }
  | { kind: "attempt-limit"; lockoutSeconds: number; body: string }
  | { kind: "suspended"; body: string }
  | { kind: "account-in-use"; seconds: number; body: string }
  | { kind: "bad-credentials"; body: string }
  | { kind: "unknown"; body: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: AuthFailure };

export interface CharList {
  nextCharId: number;
  maxNumChars: number;
  charIds: number[];
  /** null when the account has no character yet. */
  seasonal: boolean | null;
  tutorialDone: boolean;
  /** BackpackSlots > 0 on the character that will be loaded; null without a character. The authoritative slot count (stat 79 reaches few accounts). */
  hasBackpack: boolean | null;
  /** BackpackSlots as char/list gives it for that character: 0, 8 or 16; null without a character. */
  backpackSlots: number | null;
  /** Every character, so a caller that loads one other than the first reads that one's season and backpack. */
  chars: CharDetail[];
}

/** Deterministic client token, same derivation pyrelay used. */
export function clientTokenFor(guid: string, password: string): string {
  return createHash("md5").update(guid, "utf8").update(password, "utf8").digest("hex");
}

/** One account-API call as seen on the wire (rotmgnet's recorder). Additive hook; nothing in the relay registers one. */
export interface HttpRecord {
  method: "POST";
  url: string;
  /** The x-www-form-urlencoded body as sent. */
  body: string;
  status: number;
  /** The response text; "" when the request failed before a response. */
  response: string;
  error?: string;
  startedAt: number;
  endedAt: number;
  proxy: Proxy | null;
}
export const httpTaps = new Set<(rec: HttpRecord) => void>();

function postForm(url: string, form: Record<string, string>, proxy: Proxy | null): Promise<string> {
  const body = new URLSearchParams(form).toString();
  if (!httpTaps.size) return postFormRaw(url, body, proxy).then((r) => r.text);
  const startedAt = Date.now();
  return postFormRaw(url, body, proxy).then(
    (r) => {
      for (const t of httpTaps) t({ method: "POST", url, body, status: r.status, response: r.text, startedAt, endedAt: Date.now(), proxy });
      return r.text;
    },
    (e: Error) => {
      for (const t of httpTaps) t({ method: "POST", url, body, status: 0, response: "", error: e.message, startedAt, endedAt: Date.now(), proxy });
      throw e;
    },
  );
}

function postFormRaw(url: string, body: string, proxy: Proxy | null): Promise<{ status: number; text: string }> {
  const agent = proxy ? new SocksProxyAgent(proxyUrl(proxy), { timeout: AUTH_TIMEOUT_MS }) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        agent,
        headers: {
          ...REALM_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: AUTH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function lockoutFrom(text: string): number {
  const m = /(\d+)\s*minute/i.exec(text);
  return (m ? Number(m[1]) : 5) * 60;
}

/**
 * Realm's ways of saying the password is wrong: the old message, and the
 * client's own localization key that account/verify answers with for some
 * accounts (seen live 2026-09-17 on an account added with a mistyped password).
 */
export function isBadCredentials(text: string): boolean {
  return text.includes("Account credentials not valid") || text.includes("WebChangePasswordDialog.passwordError");
}
function classify(text: string): AuthFailure {
  const upper = text.toUpperCase();
  if (upper.includes("LOGIN ATTEMPT LIMIT")) return { kind: "attempt-limit", lockoutSeconds: lockoutFrom(text), body: text };
  if (upper.includes("SUSPENDED")) return { kind: "suspended", body: text };
  if (isBadCredentials(text)) return { kind: "bad-credentials", body: text };
  return { kind: "unknown", body: text };
}

export interface Credentials {
  guid: string;
  password?: string;
  secret?: string;
}

/** account/verify -> accessToken, then verifyAccessTokenClient. */
export async function getAccessToken(creds: Credentials, clientToken: string, proxy: Proxy | null): Promise<Result<string>> {
  const pwdKey = creds.password ? "password" : "secret";
  const pwdVal = creds.password || creds.secret || "";
  let text: string;
  try {
    text = await postForm(REALM_API.VERIFY, { guid: creds.guid, [pwdKey]: pwdVal, clientToken, ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  const m = /AccessToken>(.+)<\/AccessToken>/.exec(text);
  if (!m) return { ok: false, error: classify(text) };
  const accessToken = m[1];
  try {
    text = await postForm(REALM_API.VERIFY_TOKEN, { clientToken, accessToken, ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  if (!text.includes("Success")) return { ok: false, error: classify(text) };
  return { ok: true, value: accessToken };
}

const ACCOUNT_IN_USE_MAX_S = 120;

/** char/list with do_login=true — this is the call that claims the session. */
export async function getCharList(accessToken: string, proxy: Proxy | null): Promise<Result<CharList>> {
  let text: string;
  try {
    text = await postForm(REALM_API.CHAR_LIST, { do_login: "true", accessToken, ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  if (text.includes("Account in use")) {
    const m = /(\d+)/.exec(text);
    const seconds = m ? Math.min(Number(m[1]) + 3, ACCOUNT_IN_USE_MAX_S) : 60;
    return { ok: false, error: { kind: "account-in-use", seconds, body: text } };
  }
  if (isBadCredentials(text)) return { ok: false, error: { kind: "bad-credentials", body: text } };
  const head = /<Chars nextCharId="(\d+)" maxNumChars="(\d+)">/.exec(text);
  if (!head) return { ok: false, error: classify(text) };
  const charIds = [...text.matchAll(/<Char id="(\d+)">/g)].map((x) => Number(x[1]));
  let hasBackpack: boolean | null = null;
  let backpackSlots: number | null = null;
  let chars: CharDetail[] = [];
  if (charIds.length) {
    try {
      chars = parseCharListDetail(text).chars;
      const first = chars.find((c) => c.id === charIds[0]);
      hasBackpack = first ? first.hasBackpack : null;
      backpackSlots = first ? first.backpackSlots : null;
    } catch {
      hasBackpack = null;
    }
  }
  return {
    ok: true,
    value: {
      nextCharId: Number(head[1]),
      maxNumChars: Number(head[2]),
      charIds,
      seasonal: charIds.length ? text.includes("<Seasonal>True</Seasonal>") : null,
      tutorialDone: text.includes("TDone"),
      hasBackpack,
      backpackSlots,
      chars,
    },
  };
}

// --- read-only account state (backpacks, calendar, season) --------------------
// None of these claim the session (no do_login), so they are safe to call for
// an account the fleet has online. Verified live 2026-09-07 (docs/relay/BACKPACKS.md §0).

export interface CharDetail {
  id: number;
  objectType: number;
  level: number;
  seasonal: boolean;
  dead: boolean;
  /** 8 with a backpack, 0 without. */
  backpackSlots: number;
  hasBackpack: boolean;
}
export interface CharListDetail {
  nextCharId: number;
  maxNumChars: number;
  chars: CharDetail[];
}

/** Parse the per-character facts out of a char/list body. Throws when it is not a char list. */
export function parseCharListDetail(xml: string): CharListDetail {
  const head = /<Chars nextCharId="(\d+)" maxNumChars="(\d+)">/.exec(xml);
  if (!head) throw new Error(`not a char list: ${xml.slice(0, 120).replace(/\s+/g, " ")}`);
  const chars: CharDetail[] = [];
  for (const m of xml.matchAll(/<Char id="(\d+)">([\s\S]*?)<\/Char>/g)) {
    const body = m[2];
    const tag = (name: string): string | null => {
      const t = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
      return t ? t[1] : null;
    };
    const backpackSlots = Number(tag("BackpackSlots") ?? 0);
    chars.push({
      id: Number(m[1]),
      objectType: Number(tag("ObjectType") ?? -1),
      level: Number(tag("Level") ?? 0),
      seasonal: tag("Seasonal") === "True",
      dead: tag("Dead") === "True",
      backpackSlots,
      hasBackpack: backpackSlots > 0,
    });
  }
  return { nextCharId: Number(head[1]), maxNumChars: Number(head[2]), chars };
}

/** char/list without do_login: per-character backpack / seasonal / dead plus the slot count. */
export async function getCharListDetail(accessToken: string, proxy: Proxy | null): Promise<Result<CharListDetail>> {
  let text: string;
  try {
    text = await postForm(REALM_API.CHAR_LIST, { accessToken, ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  try {
    return { ok: true, value: parseCharListDetail(text) };
  } catch {
    return { ok: false, error: classify(text) };
  }
}

/** char/delete: works on the character being played as well (rotmgproxy charadmin, 2026-09-06). */
export async function deleteChar(accessToken: string, charId: number, proxy: Proxy | null): Promise<Result<true>> {
  let text: string;
  try {
    text = await postForm(REALM_API.CHAR_DELETE, { accessToken, charId: String(charId), ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  if (text.includes("<Success")) return { ok: true, value: true };
  return { ok: false, error: classify(text) };
}

export type ClaimType = "nonconsecutive" | "consecutive";
export interface CalendarDay {
  day: number;
  itemType: number;
  quantity: number;
  gold: number;
  /** Present only on a day that is reached and not yet claimed. */
  key: string | null;
}
export interface Calendar {
  /** Realm's clock when the calendar was served, epoch seconds. */
  serverTime: number;
  /** How many days each track has reached this cycle. */
  consecutiveDay: number;
  nonconsecutiveDay: number;
  nonconsecutive: CalendarDay[];
  consecutive: CalendarDay[];
}
/** Backpack, item 0xc6c: the calendar reward this whole module exists for. */
export const BACKPACK_ITEM_TYPE = 3180;

/** Parse the fetchCalendar XML. Throws when it is not a calendar (an error page, "Access denied", ...). */
export function parseCalendar(xml: string): Calendar {
  const head = /<LoginRewards\s+serverTime='([\d.]+)'\s+conCurDay\s*=\s*'(\d+)'\s+nonconCurDay\s*=\s*'(\d+)'/.exec(xml);
  if (!head) throw new Error(`not a login calendar: ${xml.slice(0, 120).replace(/\s+/g, " ")}`);
  const track = (name: string): CalendarDay[] => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
    if (!m) return [];
    const days: CalendarDay[] = [];
    for (const d of m[1].matchAll(/<Login>([\s\S]*?)<\/Login>/g)) {
      const body = d[1];
      const day = /<Days>(\d+)<\/Days>/.exec(body);
      const item = /<ItemId(?:\s+quantity='(\d+)')?>(-?\d+)<\/ItemId>/.exec(body);
      const gold = /<Gold>(\d+)<\/Gold>/.exec(body);
      const key = /<key>([^<]+)<\/key>/.exec(body);
      if (!day) continue;
      days.push({
        day: Number(day[1]),
        itemType: item ? Number(item[2]) : -1,
        quantity: item?.[1] ? Number(item[1]) : 1,
        gold: gold ? Number(gold[1]) : 0,
        key: key ? key[1] : null,
      });
    }
    return days;
  };
  return {
    serverTime: Number(head[1]),
    consecutiveDay: Number(head[2]),
    nonconsecutiveDay: Number(head[3]),
    nonconsecutive: track("NonConsecutive"),
    consecutive: track("Consecutive"),
  };
}

/** Every day on either track that pays Backpacks, with its track and whether it is claimable right now. */
export function backpackDays(cal: Calendar): { track: ClaimType; day: CalendarDay; claimable: boolean }[] {
  const out: { track: ClaimType; day: CalendarDay; claimable: boolean }[] = [];
  for (const day of cal.nonconsecutive) if (day.itemType === BACKPACK_ITEM_TYPE) out.push({ track: "nonconsecutive", day, claimable: day.key !== null });
  for (const day of cal.consecutive) if (day.itemType === BACKPACK_ITEM_TYPE) out.push({ track: "consecutive", day, claimable: day.key !== null });
  return out;
}

/** dailyLogin/fetchCalendar. */
export async function fetchCalendar(accessToken: string, proxy: Proxy | null): Promise<Result<Calendar>> {
  let text: string;
  try {
    text = await postForm(REALM_API.CALENDAR, { accessToken }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  try {
    return { ok: true, value: parseCalendar(text) };
  } catch {
    return { ok: false, error: classify(text) };
  }
}

export interface SeasonInfo {
  id: string;
  name: string;
  /** Epoch seconds. */
  start: number;
  end: number;
}

/** Parse season/seasonInfo's JSON body. Throws when it is not one. */
export function parseSeasonInfo(text: string): SeasonInfo {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`not season info: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  const o = j as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.start !== "number" || typeof o.end !== "number") throw new Error("season info without start/end");
  return { id: String(o.id ?? ""), name: String(o.name ?? "").trim(), start: o.start, end: o.end };
}

/** season/seasonInfo: the season clock. Needs any valid accessToken; the answer is account-independent. */
export async function getSeasonInfo(accessToken: string, proxy: Proxy | null): Promise<Result<SeasonInfo>> {
  let text: string;
  try {
    text = await postForm(REALM_API.SEASON_INFO, { accessToken, ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  try {
    return { ok: true, value: parseSeasonInfo(text) };
  } catch {
    return { ok: false, error: classify(text) };
  }
}

/** One entry of account/servers: the list the official client shows at login. */
export interface ServerEntry {
  name: string;
  dns: string;
  /** Load as Realm reports it, 0..1 (the client renders it as a percentage). */
  usage: number;
  adminOnly: boolean;
}

/** Parse account/servers' XML body. Throws when it is not a server list. */
export function parseServers(xml: string): ServerEntry[] {
  const out: ServerEntry[] = [];
  for (const m of xml.matchAll(/<Server>([\s\S]*?)<\/Server>/g)) {
    const body = m[1];
    const name = /<Name>([^<]*)<\/Name>/.exec(body);
    const dns = /<DNS>([^<]*)<\/DNS>/.exec(body);
    const usage = /<Usage>([^<]*)<\/Usage>/.exec(body);
    const admin = /<AdminOnly>([^<]*)<\/AdminOnly>/.exec(body);
    if (!name) continue;
    const u = usage ? Number(usage[1]) : NaN;
    out.push({ name: name[1].trim(), dns: dns ? dns[1].trim() : "", usage: Number.isFinite(u) ? u : 0, adminOnly: admin ? admin[1].trim().toLowerCase() === "true" : false });
  }
  if (!out.length) throw new Error(`not a server list: ${xml.slice(0, 120).replace(/\s+/g, " ")}`);
  return out;
}

/** account/servers: every server with its current load. Needs any valid accessToken; the answer is account-independent. */
export async function getServers(accessToken: string, proxy: Proxy | null): Promise<Result<ServerEntry[]>> {
  let text: string;
  try {
    text = await postForm(REALM_API.SERVERS, { accessToken, ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  try {
    return { ok: true, value: parseServers(text) };
  } catch {
    return { ok: false, error: classify(text) };
  }
}
