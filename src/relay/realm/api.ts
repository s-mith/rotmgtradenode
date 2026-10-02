// Realm's account HTTP API: the three calls that stand between an account
// and a game socket. Every call goes out through the account's proxy so the
// token is minted from the same exit IP the game socket will use — Realm
// treats a mismatch as the token-security signal.
import https from "node:https";
import { createHash } from "node:crypto";
import { SocksProxyAgent } from "socks-proxy-agent";
import { REALM_API, REALM_HEADERS } from "./constants";
import { proxyUrl, type Proxy } from "../net/proxy";
import { decodeSnapshotRecord } from "../protocol/enchants";

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

function postForm(url: string, form: Record<string, string>, proxy: Proxy | null, headers: Record<string, string> = REALM_HEADERS): Promise<string> {
  const body = new URLSearchParams(form).toString();
  if (!httpTaps.size) return postFormRaw(url, body, proxy, headers).then((r) => r.text);
  const startedAt = Date.now();
  return postFormRaw(url, body, proxy, headers).then(
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

function postFormRaw(url: string, body: string, proxy: Proxy | null, headers: Record<string, string> = REALM_HEADERS): Promise<{ status: number; text: string }> {
  const agent = proxy ? new SocksProxyAgent(proxyUrl(proxy), { timeout: AUTH_TIMEOUT_MS }) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        agent,
        headers: {
          ...headers,
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
 * Realm's ways of refusing a login. `WebChangePasswordDialog.passwordError`
 * is build 7's generic refusal, not a password-specific one: probing live on
 * 2026-09-17 gave that same string for a wrong password, a right password and
 * an account that does not exist. It means "these credentials were not
 * accepted" and nothing finer, so the message shown to the operator must not
 * blame the password alone.
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
  const r = await getAccessTokenDetail(creds, clientToken, proxy);
  return r.ok ? { ok: true, value: r.value.accessToken } : r;
}

/** A minted token and how long account/verify said it lasts (seconds; null when it did not say). */
export interface MintedToken {
  accessToken: string;
  lifetimeS: number | null;
}
/** The token's lifetime from account/verify's AccessTokenExpiration: seconds to live, or an epoch time; null when absent or unreadable. */
export function tokenLifetimeFrom(text: string, nowMs = Date.now()): number | null {
  const m = /<AccessTokenExpiration>\s*(\d+)\s*<\/AccessTokenExpiration>/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  // An epoch time (seconds) rather than a duration: what is left of it.
  if (n > 1e9) return Math.max(0, Math.floor(n - nowMs / 1000));
  return n;
}
/** getAccessToken, with the lifetime account/verify gave the token. */
export async function getAccessTokenDetail(creds: Credentials, clientToken: string, proxy: Proxy | null): Promise<Result<MintedToken>> {
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
  const lifetimeS = tokenLifetimeFrom(text);
  try {
    text = await postForm(REALM_API.VERIFY_TOKEN, { clientToken, accessToken, ...COMMON_FORM }, proxy);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  if (!text.includes("Success")) return { ok: false, error: classify(text) };
  return { ok: true, value: { accessToken, lifetimeS } };
}

const ACCOUNT_IN_USE_MAX_S = 120;
/**
 * A name for the account snapshot call to send as `__source`, as account
 * tools do. Empty (the default, and the operator's choice): none is sent.
 * Realm serves the full snapshot, containers included, without one
 * (verified 2026-09-22).
 */
export const SNAPSHOT_SOURCE = process.env.SNAPSHOT_SOURCE ?? "";
/** The snapshot call's headers: no Unity user agent (the game never makes this call), the encodings account tools accept. */
const SNAPSHOT_HEADERS: Record<string, string> = { Accept: "deflate, gzip" };

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
  /** The quickslots (EquipQS): the item type and how many are stacked, -1/0 when empty; two, or three once bought. */
  quickslots: { type: number; count: number }[];
  /**
   * Item type per slot as char/list lists them (0-3 equipment, 4-11 the
   * inventory, then the backpack), -1 empty; [] when the entry had no
   * Equipment. What a character the fleet is not playing carries.
   */
  equipment: number[];
}

/** An EquipQS list: `type|count` per quickslot, comma-separated; `-1|0` empty. */
export function parseQuickslots(text: string | null): { type: number; count: number }[] {
  if (!text || !text.trim()) return [];
  return text.split(",").map((s) => {
    const m = /^(-?\d+)\|(\d+)/.exec(s.trim());
    return m ? { type: Number(m[1]), count: Number(m[2]) } : { type: -1, count: 0 };
  });
}
/** An Equipment list: comma-separated item types (a suffix after `#` is ignored), -1 empty. */
export function parseEquipment(text: string | null): number[] {
  if (!text || !text.trim()) return [];
  return text.split(",").map((s) => {
    const m = /^-?\d+/.exec(s.trim());
    return m ? Number(m[0]) : -1;
  });
}
export interface CharListDetail {
  nextCharId: number;
  maxNumChars: number;
  chars: CharDetail[];
}

/** One `<Char>` body's facts. */
function parseCharBody(id: number, body: string): CharDetail {
  const tag = (name: string): string | null => {
    const t = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
    return t ? t[1] : null;
  };
  const backpackSlots = Number(tag("BackpackSlots") ?? 0);
  return {
    id,
    objectType: Number(tag("ObjectType") ?? -1),
    level: Number(tag("Level") ?? 0),
    seasonal: tag("Seasonal") === "True",
    dead: tag("Dead") === "True",
    backpackSlots,
    hasBackpack: backpackSlots > 0,
    equipment: parseEquipment(tag("Equipment")),
    quickslots: parseQuickslots(tag("EquipQS")),
  };
}

/** Parse the per-character facts out of a char/list body. Throws when it is not a char list. */
export function parseCharListDetail(xml: string): CharListDetail {
  const head = /<Chars nextCharId="(\d+)" maxNumChars="(\d+)">/.exec(xml);
  if (!head) throw new Error(`not a char list: ${xml.slice(0, 120).replace(/\s+/g, " ")}`);
  const chars: CharDetail[] = [];
  for (const m of xml.matchAll(/<Char id="(\d+)">([\s\S]*?)<\/Char>/g)) chars.push(parseCharBody(Number(m[1]), m[2]));
  return { nextCharId: Number(head[1]), maxNumChars: Number(head[2]), chars };
}

// --- the account snapshot (char/list with muleDump=true) --------------------
// The body Realm serves account tools: on top of the ordinary char list, every
// Equipment token may carry Realm's id of that copy after a `#`, `<Account>`
// holds the vault (`<Vault><Chest>…</Chest>…`), material storage, gift,
// temporary-gift and potion containers, and `<UniqueItemInfo>` blocks list
// `<ItemData type="…" id="…">base64</ItemData>` records, one per copy that
// has enchantments: per character inside its `<Char>`, and at the account
// level for the containers (`UniqueGiftItemInfo` and
// `UniqueTemporaryGiftItemInfo` for the two gift chests). A record is joined
// to its slot by (item type, copy id) when the token names one, else by
// (item type) in document order, each record used once — the join Exalt
// Account Manager makes. docs/relay/STORAGE.md "The account snapshot".

/** One slot of the snapshot: the item type (-1 empty), Realm's copy id when the token had one, and the enchantment ids of its record (null: the snapshot had no record for this slot, so it is unenchanted). */
export interface DumpSlot {
  type: number;
  copyId: string | null;
  enchantments: number[] | null;
}
export interface DumpChar extends CharDetail {
  /** Aligned with `equipment`. */
  slots: DumpSlot[];
}
export interface AccountDump {
  nextCharId: number;
  maxNumChars: number;
  /** The account's in-game name (the account block's <Name>), null when the block did not come. */
  name: string | null;
  chars: DumpChar[];
  /** Vault chests in order, 8 slots each. */
  vault: DumpSlot[][];
  materialStorage: DumpSlot[][];
  gifts: DumpSlot[];
  temporaryGifts: DumpSlot[];
  potions: DumpSlot[];
  /** ItemData records the body carried, all scopes. */
  records: number;
  /** Section tags the body had (Vault, Gifts, UniqueItemInfo, …), for the log. */
  sections: string[];
}

/** `type#copyId` tokens, `-1` empty; an unreadable token counts as empty. */
function parseTokens(csv: string | null): { type: number; copyId: string | null }[] {
  if (!csv || !csv.trim()) return [];
  return csv.split(",").map((raw) => {
    const m = /^(-?\d+)(?:#(.*))?$/.exec(raw.trim());
    return m ? { type: Number(m[1]), copyId: m[2] && m[2].trim() ? m[2].trim() : null } : { type: -1, copyId: null };
  });
}

/** The ItemData records of one UniqueItemInfo block, keyed by (type, id), each a queue in document order. */
class RecordPool {
  private readonly byKey = new Map<string, string[]>();
  count = 0;
  constructor(block: string | null) {
    if (!block) return;
    for (const m of block.matchAll(/<ItemData([^>]*)>([^<]*)<\/ItemData>/g)) {
      const type = /\btype="(-?\d+)"/.exec(m[1])?.[1];
      const id = /\bid="([^"]*)"/.exec(m[1])?.[1] ?? "";
      if (type === undefined) continue;
      const key = `${Number(type)}|${id}`;
      let q = this.byKey.get(key);
      if (!q) this.byKey.set(key, (q = []));
      q.push(m[2].trim());
      this.count++;
    }
  }
  /** The record for a slot: an exact (type, copy id) match first, else the next (type) record without an id. Used once. */
  take(type: number, copyId: string | null): string | null {
    if (copyId !== null) {
      const exact = this.byKey.get(`${type}|${copyId}`);
      if (exact?.length) return exact.shift()!;
    }
    const loose = this.byKey.get(`${type}|`);
    return loose?.length ? loose.shift()! : null;
  }
}

function resolveSlots(tokens: { type: number; copyId: string | null }[], pool: RecordPool): DumpSlot[] {
  return tokens.map((t) => {
    if (t.type <= 0) return { type: t.type, copyId: t.copyId, enchantments: null };
    const rec = pool.take(t.type, t.copyId);
    return { type: t.type, copyId: t.copyId, enchantments: rec === null ? null : decodeSnapshotRecord(rec) };
  });
}

const section = (xml: string, name: string): string | null => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null;
const chestsOf = (block: string | null): string[] => (block === null ? [] : [...block.matchAll(/<Chest>([^<]*)<\/Chest>/g)].map((m) => m[1]));

/** Parse an account snapshot. Throws when the body is not a char list. */
export function parseAccountDump(xml: string): AccountDump {
  const head = /<Chars nextCharId="(\d+)" maxNumChars="(\d+)">/.exec(xml);
  if (!head) throw new Error(`not a char list: ${xml.slice(0, 120).replace(/\s+/g, " ")}`);
  const sections = new Set<string>();
  let records = 0;
  const chars: DumpChar[] = [];
  for (const m of xml.matchAll(/<Char id="(\d+)">([\s\S]*?)<\/Char>/g)) {
    const body = m[2];
    const detail = parseCharBody(Number(m[1]), body);
    // The character's own records: the pet inside <Pet …> carries a block of its own, and <Account> is a name stub; whatever blocks remain are the character's.
    const own = body.replace(/<Pet\b[^>]*>[\s\S]*?<\/Pet>/g, "").replace(/<Account\b[^>]*>[\s\S]*?<\/Account>/g, "");
    const blocks = [...own.matchAll(/<UniqueItemInfo>([\s\S]*?)<\/UniqueItemInfo>/g)].map((b) => b[1]);
    if (blocks.length) sections.add("Char/UniqueItemInfo");
    const pool = new RecordPool(blocks.length ? blocks.join("") : null);
    records += pool.count;
    chars.push({ ...detail, slots: resolveSlots(parseTokens(section(body, "Equipment")), pool) });
  }
  // Every <Char> carries a small <Account><Name> of its own; the account block proper follows the last character.
  const tail = xml.slice(Math.max(0, xml.lastIndexOf("</Char>")));
  const account = section(tail, "Account") ?? "";
  const name = /<Name>([^<]*)<\/Name>/.exec(account)?.[1]?.trim() || null;
  for (const name of ["Vault", "MaterialStorage", "Gifts", "TemporaryGifts", "Potions", "UniqueItemInfo", "UniqueGiftItemInfo", "UniqueTemporaryGiftItemInfo"]) if (section(account, name) !== null) sections.add(`Account/${name}`);
  // Whatever the account block says about the seasonal side's storage is noted by tag name: no snapshot of an account with a seasonal character has been seen yet (2026-09-22), and Exalt Account Manager parses none, so the log is where its shape would first show.
  for (const m of account.matchAll(/<([A-Za-z]*Season[A-Za-z]*)\b/g)) sections.add(`Account/${m[1]}`);
  const shared = new RecordPool(section(account, "UniqueItemInfo"));
  const giftPool = new RecordPool(section(account, "UniqueGiftItemInfo"));
  const tempPool = new RecordPool(section(account, "UniqueTemporaryGiftItemInfo"));
  records += shared.count + giftPool.count + tempPool.count;
  // The shared pool serves the vault, then material storage, then potions, in that order.
  const vault = chestsOf(section(account, "Vault")).map((csv) => resolveSlots(parseTokens(csv), shared));
  const materialStorage = chestsOf(section(account, "MaterialStorage")).map((csv) => resolveSlots(parseTokens(csv), shared));
  const potions = resolveSlots(parseTokens(section(account, "Potions")), shared);
  const gifts = resolveSlots(parseTokens(section(account, "Gifts")), giftPool);
  const temporaryGifts = resolveSlots(parseTokens(section(account, "TemporaryGifts")), tempPool);
  return { nextCharId: Number(head[1]), maxNumChars: Number(head[2]), name, chars, vault, materialStorage, gifts, temporaryGifts, potions, records, sections: [...sections] };
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

/**
 * char/list with `muleDump=true` and without do_login: the account snapshot
 * Realm serves account tools (the community MuleDump, Exalt Account
 * Manager): every character's Equipment with a `#copy-id` suffix per item,
 * the vault, material storage, gift, temporary-gift and potion containers
 * under `<Account>`, and `<UniqueItemInfo>` blocks whose `<ItemData>`
 * records carry each copy's enchantments (see parseAccountDump). Claims no
 * session. Raw XML; the caller parses.
 */
export async function getAccountDump(accessToken: string, proxy: Proxy | null, opts: { muleDump?: boolean; source?: string } = {}): Promise<Result<string>> {
  let text: string;
  try {
    // `__source` names the tool asking, as account tools do; Realm serves the account containers only to a named source.
    // Not the game client's call, so not its headers either: account tools send a plain request (EAM: no user agent, `Accept: deflate, gzip`).
    const source = opts.source ?? SNAPSHOT_SOURCE;
    text = await postForm(REALM_API.CHAR_LIST, { accessToken, ...(opts.muleDump === false ? {} : { muleDump: "true", ...(source ? { __source: source } : {}) }), ...COMMON_FORM }, proxy, SNAPSHOT_HEADERS);
  } catch (e) {
    return { ok: false, error: { kind: "network", detail: (e as Error).message } };
  }
  if (!/<Chars nextCharId="\d+" maxNumChars="\d+">/.test(text)) return { ok: false, error: classify(text) };
  return { ok: true, value: text };
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
