// The account roster: Accounts.json on disk, plus per-account live state.
// Port of Communism/BotPool (same file format, same bot_guid derivation).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Proxy } from "../net/proxy";
import type { GameClient } from "../client/gameClient";
import { open as unseal, seal } from "../../node/secrets";

/** Stable server-side id for an account: sha256(email), base64url, 32 chars. */
export function deriveBotGuid(email: string): string {
  return createHash("sha256").update(email, "utf8").digest("base64url").slice(0, 32);
}

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
}

export type AssignmentKind = "deposit" | "withdraw" | "consolidate_give" | "consolidate_take";

export class BotAccount {
  readonly guid: string;
  readonly botGuid: string;
  alias: string;
  seasonal: boolean | null;
  suspended: boolean;
  inUse = false;
  client: GameClient | null = null;
  assignedRequestId: number | null = null;
  assignedKind: AssignmentKind | null = null;
  assignedPartnerIgn: string | null = null;
  /** Personal storage: the account a claimed deposit's items belong to. */
  assignedVaultUser: number | null = null;

  constructor(public info: AccountInfo) {
    this.guid = info.guid;
    this.alias = info.alias || info.guid;
    this.botGuid = deriveBotGuid(info.guid);
    this.seasonal = info.seasonal === undefined || info.seasonal === null ? null : Boolean(info.seasonal);
    this.suspended = Boolean(info.suspended);
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
    if (!fs.existsSync(this.accountsPath)) return null;
    try {
      // Sealed at rest (src/node/secrets.ts); a plaintext file from before still reads.
      const raw = JSON.parse(unseal(fs.readFileSync(this.accountsPath, "utf8").trim()));
      return Array.isArray(raw) ? raw.filter((e) => e && typeof e === "object" && typeof e.guid === "string" && e.guid) : null;
    } catch (e) {
      console.log(`BotPool: failed to parse ${this.accountsPath}: ${String(e)}`);
      return null;
    }
  }
  private writeFile(entries: AccountInfo[]): void {
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
    return this.accounts.find((a) => a.guid === guid);
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
    acc.assignedVaultUser = null;
  }

  /** Add an account dispensed by accountgen; persists before returning. */
  addPulled(entry: AccountInfo): BotAccount | null {
    if (this.accounts.some((a) => a.guid === entry.guid)) return null;
    this.patchFile((entries) => entries.push(entry));
    const acc = new BotAccount(entry);
    this.push(acc);
    return acc;
  }
}

/** In-process accountgen, when it runs inside this process. */
export type LocalAccountSource = (seasonal: boolean | null | undefined) => Promise<{ email: string; password: string; name: string; server: string | null; seasonal: boolean | null } | null>;
declare global {
  // eslint-disable-next-line no-var
  var __local_accountgen__: LocalAccountSource | undefined;
}
export function registerLocalAccountSource(fn: LocalAccountSource | undefined): void {
  globalThis.__local_accountgen__ = fn;
}

/** Pull one tutorial-finished account from accountgen (in-process if embedded, else HTTP). */
export async function pullAccount(
  pool: BotPool,
  opts: { server?: string; seasonal?: boolean | null } = {},
): Promise<BotAccount | null> {
  const local = globalThis.__local_accountgen__;
  if (local) {
    const a = await local(opts.seasonal);
    if (!a) return null;
    const entry: AccountInfo = { alias: a.name || a.email.split("@")[0], guid: a.email, password: a.password, seasonal: a.seasonal ?? (opts.seasonal ?? true) };
    if (opts.server || a.server) entry.server = opts.server || a.server || undefined;
    const acc = pool.addPulled(entry);
    if (acc) console.log(`BotPool.pullAccount: added ${acc.alias} from the embedded accountgen (pool now ${pool.all().length})`);
    return acc;
  }
  const base = (process.env.ACCOUNTGEN_URL ?? "").replace(/\/$/, "");
  const auth = process.env.ACCOUNTGEN_AUTH ?? "";
  if (!base || !auth) return null;
  const params = new URLSearchParams();
  if (opts.seasonal !== null && opts.seasonal !== undefined) params.set("seasonal", opts.seasonal ? "1" : "0");
  let res: Response;
  try {
    res = await fetch(`${base}/account${params.size ? `?${params}` : ""}`, {
      headers: { "X-Accountgen-Auth": auth },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.log(`BotPool.pullAccount: accountgen request failed: ${String(e)}`);
    return null;
  }
  if (res.status === 503) {
    console.log("BotPool.pullAccount: accountgen pool empty — worker is refilling");
    return null;
  }
  if (!res.ok) {
    console.log(`BotPool.pullAccount: accountgen returned HTTP ${res.status}`);
    return null;
  }
  let body: { account?: { email?: string; password?: string; name?: string; seasonal?: boolean; server?: string } };
  try {
    body = await res.json();
  } catch {
    console.log("BotPool.pullAccount: accountgen returned a non-JSON body");
    return null;
  }
  const acct = body.account ?? {};
  if (!acct.email || !acct.password) {
    console.log("BotPool.pullAccount: accountgen response missing email/password");
    return null;
  }
  const entry: AccountInfo = {
    alias: acct.name || acct.email.split("@")[0],
    guid: acct.email,
    password: acct.password,
    seasonal: acct.seasonal ?? (opts.seasonal ?? true),
  };
  if (opts.server || acct.server) entry.server = opts.server || acct.server;
  const acc = pool.addPulled(entry);
  if (!acc) {
    console.log(`BotPool.pullAccount: ${acct.email} already in pool — skipping`);
    return null;
  }
  console.log(`BotPool.pullAccount: added ${acc.alias} from accountgen (pool now ${pool.all().length})`);
  return acc;
}
