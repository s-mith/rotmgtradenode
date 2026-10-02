// The account roster: Accounts.json on disk, plus per-account live state.
// Port of Communism/BotPool (same file format, same bot_guid derivation).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Proxy } from "../net/proxy";
import type { GameClient } from "../client/gameClient";
import { open as unseal, seal } from "../../node/secrets";

/** Stable server-side id for an account: sha256(email), base64url, 32 chars. */
/**
 * A bot's id, hashed from the address exactly as written — the derivation
 * pyrelay used, so state files carried over from it still line up (see the
 * fixtures). Correcting an address's capitalisation therefore gives the
 * account a new id, which is why that is refused while it holds items.
 */
export function deriveBotGuid(email: string): string {
  return createHash("sha256").update(email, "utf8").digest("base64url").slice(0, 32);
}
/**
 * Whether two login addresses name the same account. Realm compares the
 * address as registered (an account made as `Name@host` is refused
 * `name@host`), so the node stores it as typed; but one mailbox is one
 * account here, whatever the spelling, so the roster never holds both.
 */
export const sameAccount = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Accounts that served the sister site (rotmgcapitalism, now retired) hold its
 * users' property and stay in Accounts.json untouched, but they are not part
 * of this fleet: never logged in, never counted, never offered to anyone.
 */
function isRetiredEconomy(entry: AccountInfo): boolean {
  return entry.economy === "capitalism";
}

export interface AccountInfo {
  alias?: string;
  guid: string;
  password?: string;
  secret?: string;
  server?: string;
  proxy?: Partial<Proxy>;
  seasonal?: boolean;
  /** Legacy: accounts flagged for the retired capitalism site are skipped on load. */
  economy?: string;
  suspended?: boolean;
  /** Set aside for communism: its slots are communism capacity, its items communism items; never pool work. */
  communism?: boolean;
  /** The character this account logs in with, when it still exists (docs/relay/STORAGE.md); unset = the first one. */
  charId?: number;
}

export type AssignmentKind = "deposit" | "withdraw" | "consolidate_give" | "consolidate_take";

export class BotAccount {
  readonly guid: string;
  readonly botGuid: string;
  alias: string;
  seasonal: boolean | null;
  suspended: boolean;
  communism: boolean;
  inUse = false;
  client: GameClient | null = null;
  assignedRequestId: number | null = null;
  assignedKind: AssignmentKind | null = null;
  assignedPartnerIgn: string | null = null;
  /** Why the last bring-up did not get the account in world, until one does (shown on the Accounts tab). */
  lastLoginError: { at: number; kind: string; message: string } | null = null;

  constructor(public info: AccountInfo) {
    this.guid = info.guid;
    this.alias = info.alias || info.guid;
    this.botGuid = deriveBotGuid(info.guid);
    this.seasonal = info.seasonal === undefined || info.seasonal === null ? null : Boolean(info.seasonal);
    this.suspended = Boolean(info.suspended);
    // A roster entry from before the rename (2026-09-22) carries the flag under the old key; it is read once and written back under the new one.
    const legacy = (info as { commons?: boolean }).commons;
    if (info.communism === undefined && legacy !== undefined) {
      info.communism = Boolean(legacy);
      delete (info as { commons?: boolean }).commons;
    }
    this.communism = Boolean(info.communism);
  }
  /** Unknown pool counts as seasonal, the pre-split default. */
  get seasonalOrDefault(): boolean {
    return this.seasonal === null ? true : this.seasonal;
  }
  get online(): boolean {
    return this.client !== null && this.client.active;
  }
}

export class BotPool {
  private accounts: BotAccount[] = [];
  private byBot = new Map<string, BotAccount>();
  /** all() is asked for many times a tick; rebuilt when the roster or a suspension changes. */
  private usable: BotAccount[] | null = null;
  private suspendedCache: { revision: number; guids: Set<string> } | null = null;
  /** Bumped on every roster change: an addition, a suspension, a seasonality flip. */
  revision = 0;
  /** The file as last read or written, so reload() can skip parsing an unchanged file. */
  private fileStat: { mtimeMs: number; size: number } | null = null;
  /** Set while Accounts.json exists but cannot be opened (wrong or missing sealing key, corruption): nothing may overwrite it then. */
  private unreadable = false;

  constructor(readonly accountsPath: string) {
    this.load();
  }

  private statFile(): { mtimeMs: number; size: number } | null {
    try {
      const st = fs.statSync(this.accountsPath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }
  private touched(): void {
    this.usable = null;
    this.suspendedCache = null;
    this.revision++;
  }
  static at(dataDir: string): BotPool {
    return new BotPool(path.join(dataDir, "Accounts.json"));
  }

  private readFile(): AccountInfo[] | null {
    if (!fs.existsSync(this.accountsPath)) {
      this.unreadable = false;
      return null;
    }
    try {
      // Sealed at rest (src/node/secrets.ts); a plaintext file from before still reads.
      const raw = JSON.parse(unseal(fs.readFileSync(this.accountsPath, "utf8").trim()));
      if (!Array.isArray(raw)) throw new Error("not a list of accounts");
      this.unreadable = false;
      return raw.filter((e) => e && typeof e === "object" && typeof e.guid === "string" && e.guid);
    } catch (e) {
      this.unreadable = true;
      console.error(`BotPool: cannot open ${this.accountsPath}: ${String(e)}. The roster is left untouched on disk; no change is saved until it opens again.`);
      return null;
    }
  }
  private writeFile(entries: AccountInfo[]): void {
    // Overwriting a roster this process could not open would replace every stored account with whatever is in memory.
    if (this.unreadable) {
      console.error(`BotPool: not saving ${this.accountsPath}: it could not be opened, and overwriting it would lose the accounts in it`);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.accountsPath), { recursive: true });
      fs.writeFileSync(this.accountsPath, seal(JSON.stringify(entries, null, 2)) + "\n", { mode: 0o600 });
      this.fileStat = this.statFile();
    } catch (e) {
      console.log(`BotPool: failed to persist ${this.accountsPath}: ${String(e)}`);
    }
  }
  private load(): void {
    this.fileStat = this.statFile();
    const raw = this.readFile();
    if (!raw) {
      console.log(`BotPool: ${this.accountsPath} missing or unreadable — starting with an empty pool`);
      return;
    }
    const seen = new Set<string>();
    const dupes: string[] = [];
    let retired = 0;
    for (const entry of raw) {
      if (seen.has(entry.guid)) {
        dupes.push(entry.guid);
        continue;
      }
      seen.add(entry.guid);
      if (isRetiredEconomy(entry)) {
        retired++;
        continue;
      }
      this.push(new BotAccount(entry));
    }
    console.log(`BotPool: loaded ${this.accounts.length} bot accounts${retired ? ` (${retired} left to the retired capitalism site)` : ""}`);
    if (dupes.length) console.log(`BotPool: WARNING — ${dupes.length} duplicate guid(s) ignored: ${[...new Set(dupes)].sort().join(", ")}`);
  }

  /** Pick up entries added to the file since startup. Returns how many. */
  reload(): number {
    // Every supervise pass calls this; parsing a multi-megabyte roster each
    // time was pure waste, so a file unchanged since it was last read or
    // written (same size and mtime) is skipped.
    const st = this.statFile();
    if (st && this.fileStat && st.mtimeMs === this.fileStat.mtimeMs && st.size === this.fileStat.size) return 0;
    this.fileStat = st;
    const raw = this.readFile();
    if (!raw) return 0;
    const have = new Set(this.accounts.map((a) => a.guid));
    let added = 0;
    for (const entry of raw) {
      if (have.has(entry.guid) || isRetiredEconomy(entry)) continue;
      this.push(new BotAccount(entry));
      have.add(entry.guid);
      added++;
    }
    if (added) console.log(`BotPool.reload: picked up ${added} new account(s)`);
    return added;
  }

  /** Usable accounts (suspended ones excluded). One shared array: read it, don't sort or splice it. */
  all(): BotAccount[] {
    return (this.usable ??= this.accounts.filter((a) => !a.suspended));
  }
  /** Every account, suspended included. Operator inspection only. */
  every(): BotAccount[] {
    return [...this.accounts];
  }
  byGuid(guid: string): BotAccount | undefined {
    return this.accounts.find((a) => sameAccount(a.guid, guid));
  }
  /** Indexed: the dispatcher asks this per pass for thousands of accounts. */
  byBotGuid(botGuid: string): BotAccount | undefined {
    return this.byBot.get(botGuid);
  }
  private push(acc: BotAccount): void {
    this.accounts.push(acc);
    this.byBot.set(acc.botGuid, acc);
    this.touched();
  }
  suspendedBotGuids(): Set<string> {
    if (this.suspendedCache?.revision !== this.revision) {
      this.suspendedCache = { revision: this.revision, guids: new Set(this.accounts.filter((a) => a.suspended).map((a) => a.botGuid)) };
    }
    return this.suspendedCache.guids;
  }

  private patchFile(mutate: (entries: AccountInfo[]) => void): void {
    let entries = this.readFile();
    if (!entries) entries = this.accounts.map((a) => a.info);
    mutate(entries);
    this.writeFile(entries);
  }

  markSuspended(guid: string): BotAccount | undefined {
    const acc = this.byGuid(guid);
    if (!acc) return undefined;
    if (acc.suspended) return acc;
    acc.suspended = true;
    acc.info.suspended = true;
    this.touched();
    this.patchFile((entries) => {
      let found = false;
      for (const e of entries) if (e.guid === guid) { e.suspended = true; found = true; }
      if (!found) entries.push(acc.info);
    });
    console.log(`BotPool: RETIRED ${acc.alias} — Realm reports the account suspended`);
    return acc;
  }

  /** The owner re-checked the account and Realm accepts it again. */
  clearSuspended(guid: string): BotAccount | undefined {
    const acc = this.byGuid(guid);
    if (!acc || !acc.suspended) return acc;
    acc.suspended = false;
    acc.info.suspended = false;
    this.touched();
    this.patchFile((entries) => {
      for (const e of entries) if (e.guid === guid) e.suspended = false;
    });
    console.log(`BotPool: ${acc.alias} un-retired by the owner`);
    return acc;
  }

  /** Which character the account logs in with from now on; null goes back to the first listed. Takes effect at the next login. */
  setPreferredChar(acc: BotAccount, charId: number | null): void {
    if ((acc.info.charId ?? null) === charId) return;
    if (charId === null) delete acc.info.charId;
    else acc.info.charId = charId;
    this.revision++;
    this.patchFile((entries) => {
      for (const e of entries) if (e.guid === acc.guid) {
        if (charId === null) delete e.charId;
        else e.charId = charId;
      }
    });
    console.log(`BotPool: ${acc.alias} logs in with ${charId === null ? "its first character" : `character ${charId}`} from now on`);
  }

  /**
   * A new email for an account the owner mistyped. The email IS the identity
   * (botGuid derives from it), so the record is replaced by an equivalent one
   * under the new address, keeping the alias, pool, server and character
   * choice. Everything the fleet filed under the old bot guid (tracked items,
   * backpack and storage state) belongs to the old identity and is left
   * behind, so the caller must refuse this for an account that holds items.
   */
  setEmail(acc: BotAccount, email: string): BotAccount | { error: string } {
    const next = email.trim();
    if (!next || next === acc.guid) return acc;
    if (this.accounts.some((a) => a !== acc && sameAccount(a.guid, next))) return { error: "another account on the roster already uses that email" };
    const i = this.accounts.indexOf(acc);
    if (i < 0) return { error: "that account is not on the roster" };
    const info: AccountInfo = { ...acc.info, guid: next };
    const replacement = new BotAccount(info);
    this.accounts[i] = replacement;
    this.byBot.delete(acc.botGuid);
    this.byBot.set(replacement.botGuid, replacement);
    this.touched();
    this.patchFile((entries) => {
      const j = entries.findIndex((e) => sameAccount(e.guid, acc.guid));
      if (j >= 0) entries[j] = info;
      else entries.push(info);
    });
    console.log(`BotPool: ${acc.alias} is now ${next}${replacement.botGuid === acc.botGuid ? " (same account, corrected spelling)" : ""}`);
    return replacement;
  }

  /**
   * Take an account off the roster for good: the node forgets its login and
   * stops using it. The caller makes sure it is not mid-trade. What the
   * fleet filed under its bot guid (tracked items, storage and backpack
   * state) is the caller's to drop; the items themselves stay on the account
   * in the game.
   */
  remove(acc: BotAccount): boolean {
    const i = this.accounts.indexOf(acc);
    if (i < 0) return false;
    this.accounts.splice(i, 1);
    this.byBot.delete(acc.botGuid);
    this.touched();
    this.patchFile((entries) => {
      const j = entries.findIndex((e) => sameAccount(e.guid, acc.guid));
      if (j >= 0) entries.splice(j, 1);
    });
    console.log(`BotPool: ${acc.alias} removed from the roster`);
    return true;
  }

  /** A new password for an account (the owner corrected it). Persists; the gate is the caller's to unlock. */
  setPassword(acc: BotAccount, password: string): void {
    acc.info.password = password;
    delete acc.info.secret;
    this.revision++;
    this.patchFile((entries) => {
      for (const e of entries) if (e.guid === acc.guid) {
        e.password = password;
        delete e.secret;
      }
    });
    acc.lastLoginError = null;
    console.log(`BotPool: ${acc.alias} has a new password`);
  }

  setSeasonal(acc: BotAccount, seasonal: boolean): void {
    if (acc.seasonal === seasonal) return;
    acc.seasonal = seasonal;
    acc.info.seasonal = seasonal;
    this.revision++;
    this.patchFile((entries) => {
      for (const e of entries) if (e.guid === acc.guid) e.seasonal = seasonal;
    });
    console.log(`BotPool: ${acc.alias} is ${seasonal ? "seasonal" : "non-seasonal"}`);
  }

  /** Move an account into or out of communism. Takes effect on the next supervise pass. */
  setCommunism(acc: BotAccount, communism: boolean): void {
    if (acc.communism === communism) return;
    acc.communism = communism;
    acc.info.communism = communism;
    this.revision++;
    this.patchFile((entries) => {
      for (const e of entries) if (e.guid === acc.guid) {
        if (communism) e.communism = true;
        else delete e.communism;
      }
    });
    console.log(`BotPool: ${acc.alias} is ${communism ? "a communism account" : "a pool account"}`);
  }

  markAllNonseasonal(): { changed: number; total: number } {
    const total = this.accounts.length;
    const changed = this.accounts.filter((a) => a.seasonal !== false).length;
    for (const a of this.accounts) {
      a.seasonal = false;
      a.info.seasonal = false;
    }
    this.revision++;
    this.patchFile((entries) => {
      for (const e of entries) e.seasonal = false;
    });
    console.log(`BotPool: marked all ${total} account(s) non-seasonal (${changed} were not already)`);
    return { changed, total };
  }

  reserve(acc: BotAccount): boolean {
    if (acc.inUse) return false;
    acc.inUse = true;
    return true;
  }
  release(acc: BotAccount): void {
    acc.inUse = false;
    acc.assignedRequestId = null;
    acc.assignedKind = null;
    acc.assignedPartnerIgn = null;
  }

  /** Called with every account that joins the roster while the process runs (the fleet sweeps it). */
  onAdded: ((acc: BotAccount) => void) | null = null;

  /** Add an account the owner gave; persists before returning. */
  addPulled(entry: AccountInfo): BotAccount | null {
    if (this.accounts.some((a) => sameAccount(a.guid, entry.guid))) return null;
    this.patchFile((entries) => entries.push(entry));
    const acc = new BotAccount(entry);
    this.push(acc);
    this.onAdded?.(acc);
    return acc;
  }
}
