// Access tokens kept between an account's logins (advanced management,
// docs/relay/ADVANCED.md): a reconnect or a character switch within the
// token's lifetime skips account/verify and goes straight to char/list, the
// call that claims the session. Keyed by account and exit: Realm ties a
// token to the IP that minted it (realm/api.ts), so a login through another
// exit mints its own.

/** The longest a token is handed out again, whatever Realm says it lasts: Realm's game server refused kept tokens 12-16 minutes old (live 2026-10-01) while ones up to 10 minutes old loaded. */
export const TOKEN_REUSE_MAX_S = Number(process.env.TOKEN_REUSE_MAX_SECONDS ?? 600);
/** A token this close to the end of Realm's own lifetime for it is not handed out again. */
const EXPIRY_MARGIN_S = 60;

export interface CachedToken {
  token: string;
  /** When it was minted (ms epoch): what the FAILURE line's token age counts from. */
  issuedAt: number;
  /** Until when it is handed out (ms epoch). */
  until: number;
}

export class TokenCache {
  private readonly entries = new Map<string, CachedToken>();
  constructor(private readonly now: () => number = Date.now) {}

  private static key(guid: string, exit: string): string {
    return `${guid}\u0000${exit}`;
  }
  /** The token to log in with through this exit, or null (none, or past its time: then it is forgotten). */
  get(guid: string, exit: string): CachedToken | null {
    const k = TokenCache.key(guid, exit);
    const e = this.entries.get(k);
    if (!e) return null;
    if (this.now() >= e.until) {
      this.entries.delete(k);
      return null;
    }
    return e;
  }
  /** Keep a freshly minted token: `lifetimeS` is what account/verify said it lasts (null when it did not say). */
  set(guid: string, exit: string, token: string, issuedAt: number, lifetimeS: number | null): void {
    if (!token) return;
    let keepS = TOKEN_REUSE_MAX_S;
    if (lifetimeS !== null) keepS = Math.min(keepS, lifetimeS - EXPIRY_MARGIN_S);
    if (keepS <= 0) return;
    // One token per account: a mint through another exit replaces the last.
    this.invalidate(guid);
    this.entries.set(TokenCache.key(guid, exit), { token, issuedAt, until: issuedAt + keepS * 1000 });
  }
  /** Forget the account's token (a token error, bad credentials, a suspension, a refused reuse). */
  invalidate(guid: string): void {
    const prefix = `${guid}\u0000`;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }
  clear(): void {
    this.entries.clear();
  }
  get size(): number {
    return this.entries.size;
  }
}

/** The process's cache: bringUp keeps and reuses advanced accounts' tokens here. */
export const tokenCache = new TokenCache();

/** The exit a login goes out through, as the cache keys it: the proxy's host and port, or this computer's own IP. */
export function exitKey(proxy: { host: string; port: number } | null): string {
  return proxy ? `${proxy.host}:${proxy.port}` : "direct";
}

const stats = { minted: 0, reused: 0, reuseFailed: 0 };
/**
 * Logins by how they got their token, since the process started: minted
 * (account/verify, every account), reused (a kept token, advanced accounts),
 * reuseFailed (a kept token char/list refused; a fresh one was minted).
 */
export function loginStats(): { minted: number; reused: number; reuseFailed: number } {
  return { ...stats };
}
export function noteLoginToken(kind: keyof typeof stats): void {
  stats[kind]++;
}
/** Tests only. */
export function resetLoginStats(): void {
  stats.minted = 0;
  stats.reused = 0;
  stats.reuseFailed = 0;
}

// --- logins per account -------------------------------------------------------------
// Every login that reached Realm (char/list said yes), whatever it was for:
// a wake, a storage visit, a sweep. Realm throttles an account that logs in
// too often ("Please wait a bit and reconnect"), so background work under
// advanced management only runs while an account is well inside a budget
// (dispatcher.ts); work for players is never held back by it.
const loginTimes = new Map<string, number[]>();
const LOGIN_MEMORY_MS = 3_600_000;

/** An account's login went through. */
export function noteAccountLogin(guid: string, now = Date.now()): void {
  const times = (loginTimes.get(guid) ?? []).filter((t) => now - t < LOGIN_MEMORY_MS);
  times.push(now);
  loginTimes.set(guid, times);
}
/** The account's logins within the last `ms` (at most the last hour is remembered). */
export function accountLoginsWithin(guid: string, ms: number, now = Date.now()): number {
  return (loginTimes.get(guid) ?? []).filter((t) => now - t < ms).length;
}
/** Tests: forget every account's logins. */
export function resetAccountLogins(): void {
  loginTimes.clear();
}
