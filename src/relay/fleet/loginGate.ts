// Who may log in right now: per-account lockouts, the fleet-wide breaker,
// and benched servers. Port of the policy half of pyrelay's ClientManager.
const LOGIN_LIMIT_TRIP_COUNT = Number(process.env.LOGIN_LIMIT_TRIP_COUNT ?? 3);
const LOGIN_LIMIT_TRIP_WINDOW_MS = Number(process.env.LOGIN_LIMIT_TRIP_WINDOW_SECONDS ?? 60) * 1000;
const LOGIN_PAUSE_MS = Number(process.env.LOGIN_PAUSE_SECONDS ?? 300) * 1000;
const FOREVER_MS = 365 * 24 * 3600 * 1000;
/** How long a hold reports as "paused" to callers that only look at the clock. */
const HOLD_MS = 3600 * 1000;

export class LoginGate {
  /** Per-account cooldowns: Realm's attempt limit, "account in use", the grace after a session. */
  private lockedUntil = new Map<string, number>();
  /** Accounts Realm suspended: locked until unlocked, whatever their cooldowns say. */
  private retired = new Set<string>();
  /** Accounts Realm refused the stored credentials for: no login is tried again until they are corrected (unlock), so a wrong password never meets Realm's attempt limit over and over. */
  private badCredentials = new Set<string>();
  private serverJamUntil = new Map<string, number>();
  private attemptLimitHits: number[] = [];
  private pauseUntil = 0;
  private pauseLoggedAt = 0;
  /** A standing hold (the build gate): logins refused until released, whatever the clock says. */
  holdReason: string | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Retired for good (a suspension): never logs in again this run. */
  isRetired(guid: string): boolean {
    return this.retired.has(guid);
  }
  lockoutRemainingMs(guid: string): number {
    if (this.retired.has(guid) || this.badCredentials.has(guid)) return FOREVER_MS;
    return this.cooldownRemainingMs(guid);
  }
  /** The account's own cooldown, a suspension's retire left aside: what an HTTP re-check of a suspended account still waits out. */
  cooldownRemainingMs(guid: string): number {
    return Math.max(0, (this.lockedUntil.get(guid) ?? 0) - this.now());
  }
  /** Time until logins may resume; while a hold is on this never runs out. */
  pausedRemainingMs(): number {
    const p = Math.max(0, this.pauseUntil - this.now());
    return this.holdReason ? Math.max(p, HOLD_MS) : p;
  }
  /** The rate-limit pause alone, for a caller allowed past the hold. */
  ratePauseRemainingMs(): number {
    return Math.max(0, this.pauseUntil - this.now());
  }
  hold(reason: string): void {
    if (this.holdReason !== reason) console.log(`LoginGate: holding all logins — ${reason}`);
    this.holdReason = reason;
  }
  release(): void {
    if (this.holdReason) console.log("LoginGate: hold released");
    this.holdReason = null;
  }
  serverJamRemainingMs(server: string): number {
    return Math.max(0, (this.serverJamUntil.get(server) ?? 0) - this.now());
  }

  /** Extend (never shorten) an account's lockout. */
  noteCooldown(guid: string, seconds: number, why: string): void {
    if (seconds <= 0) return;
    const before = this.lockoutRemainingMs(guid);
    const until = this.now() + seconds * 1000;
    if (until > (this.lockedUntil.get(guid) ?? 0)) this.lockedUntil.set(guid, until);
    const after = this.lockoutRemainingMs(guid);
    if (after > before) console.log(`LoginGate: ${guid} not logging in for ${Math.floor(after / 1000)}s — ${why}`);
  }

  /** Realm refused with LOGIN ATTEMPT LIMIT: lock the account and count it against the channel. */
  noteAttemptLimit(guid: string, lockoutSeconds: number): void {
    this.noteCooldown(guid, lockoutSeconds, "login attempt limit");
    const now = this.now();
    this.attemptLimitHits = this.attemptLimitHits.filter((t) => now - t < LOGIN_LIMIT_TRIP_WINDOW_MS);
    this.attemptLimitHits.push(now);
    const hits = this.attemptLimitHits.length;
    if (hits < LOGIN_LIMIT_TRIP_COUNT || this.pauseUntil > now) return;
    this.pauseUntil = now + LOGIN_PAUSE_MS;
    this.attemptLimitHits = [];
    console.log(`LoginGate: ${hits} attempt-limit refusals inside ${LOGIN_LIMIT_TRIP_WINDOW_MS / 1000}s — pausing ALL logins for ${LOGIN_PAUSE_MS / 1000}s`);
  }
  noteLoginSuccess(): void {
    this.attemptLimitHits = [];
  }
  /** Realm said the stored email/password are wrong: hold the account until the owner corrects them. */
  noteBadCredentials(guid: string): void {
    if (this.badCredentials.has(guid)) return;
    this.badCredentials.add(guid);
    console.log(`LoginGate: ${guid} not logging in until its credentials are corrected — Realm refused them`);
  }
  hasBadCredentials(guid: string): boolean {
    return this.badCredentials.has(guid);
  }
  retire(guid: string): void {
    this.retired.add(guid);
  }
  /** Undo a retire (or any lockout): the account may log in on the next wake. */
  unlock(guid: string): void {
    this.retired.delete(guid);
    this.badCredentials.delete(guid);
    this.lockedUntil.delete(guid);
  }
  noteServerJam(server: string, seconds: number, why = ""): void {
    if (!server || seconds <= 0) return;
    const now = this.now();
    const fresh = (this.serverJamUntil.get(server) ?? 0) <= now;
    const until = now + seconds * 1000;
    if (until > (this.serverJamUntil.get(server) ?? 0)) this.serverJamUntil.set(server, until);
    if (fresh) console.log(`LoginGate: benching ${server} for ~${seconds}s — ${why}`);
  }
  /** Log the pause at most every 15s; returns true when a line was printed. */
  notePauseRefusal(): boolean {
    const now = this.now();
    if (now - this.pauseLoggedAt < 15_000) return false;
    this.pauseLoggedAt = now;
    return true;
  }
}
