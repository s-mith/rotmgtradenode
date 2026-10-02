// Bring one account online: claim an exit IP, authenticate, open the game
// socket. The policy consequences of each failure (lockouts, retirement,
// breaker) are recorded here so every caller (supervisor, sweeps) shares
// one truth. Port of ClientManager.addClient / _bringUpClient.
import { GameClient } from "../client/gameClient";
import type { Proxy } from "../net/proxy";
import { DEFAULT_SERVER, isServerName } from "../realm/constants";
import type { BotAccount, BotPool } from "./botPool";
import type { LoginGate } from "./loginGate";
import type { ProxyPool } from "./proxyPool";
import type { ServerList } from "../realm/serverList";
import type { AuthFailure } from "../realm/api";
import { DIRECT_ONLINE_BOTS, RECONNECT_GRACE_S, TOKEN_ERROR_COOLDOWN_S } from "./constants";
import { exitKey, noteAccountLogin, noteLoginToken, tokenCache } from "./tokenCache";

export type BringUpVerdict = "captured" | "suspended" | "locked" | "paused" | "failed";

export interface FleetDeps {
  pool: BotPool;
  proxies: ProxyPool;
  gate: LoginGate;
  /** Build string for HELLO; a getter when the fleet follows the version feed. */
  buildVersion: string;
  /** Re-check the version feed now (after an `s.update_client` kick). */
  refreshBuildVersion?: () => Promise<boolean>;
  /** Live clients by account guid; the single answer to "who is online". */
  clients: Map<string, GameClient>;
  log: (line: string) => void;
  /** Test hook: replaces the real authenticate+connect bring-up. */
  bringUp?: (deps: FleetDeps, acc: BotAccount, server: string, opts?: BringUpOptions) => Promise<GameClient>;
  /** The tracker's slot count for a bot (16 once a backpack is known); seeds the client's knownBackpack at bring-up. */
  capacityFor?: (botGuid: string) => number;
  /** Every successful authenticate: the backpack service records the login and what char/list said. */
  onLogin?: (acc: BotAccount, client: GameClient) => void;
  /** Realm's server addresses; refreshed with the fresh token before the socket opens when stale. */
  servers?: ServerList;
  /** When true, a login with no proxy to use is refused rather than made from this host's IP. */
  requireProxy?: () => boolean;
  /** Which catalog items the node takes in (src/lib/itemPolicy.ts); absent = everything tradeable. */
  itemPolicy?: () => import("../../lib/itemPolicy").ItemPolicy;
  /** Whether this account follows advanced management (docs/relay/ADVANCED.md): its pool's switch. Absent = never. */
  isAdvanced?: (acc: BotAccount) => boolean;
}

export class BringUpRefused extends Error {
  /** `busy`: nothing is wrong with the account, only every proxy host carries a bot right now. */
  constructor(readonly verdict: BringUpVerdict, message: string, readonly busy = false) {
    super(message);
  }
}
/** A refusal that passes by itself (logins paused or locked for a while, every proxy host in use): a queued job waits it out rather than failing. */
export const refusalPasses = (e: unknown): boolean => e instanceof BringUpRefused && (e.busy || e.verdict === "locked" || e.verdict === "paused");

/**
 * Create, authenticate and connect a client for `acc` on `server`.
 * Resolves with the client, or rejects with BringUpRefused carrying the
 * verdict. Everything short of a live client releases the exit IP.
 */
export interface BringUpOptions {
  /** When the account has no character, CREATE one with this seasonality. Default: non-seasonal. */
  createSeasonal?: boolean;
  /** CREATE a character even though the account has some (a new one in a free slot). Like `charId`, not the account's character of record: no roster season, no login hooks. */
  createForce?: boolean;
  /** The build gate's canary: go past a standing hold (never past a rate-limit pause). */
  ignoreHold?: boolean;
  /**
   * Log in as this character instead of the account's usual one: a look at
   * another character (a storage read, docs/relay/STORAGE.md). The session
   * is not the account's character of record, so its season is not written
   * to the roster and the login hooks (the backpack record, the character
   * switch bookkeeping) do not run.
   */
  charId?: number;
}

export async function bringUp(deps: FleetDeps, acc: BotAccount, server: string, opts: BringUpOptions = {}): Promise<GameClient> {
  const { pool, proxies, gate, clients, log } = deps;
  const label = acc.alias || acc.guid;
  if (!acc.info.guid || (!acc.info.password && !acc.info.secret)) throw new BringUpRefused("failed", "empty guid or password");

  const paused = opts.ignoreHold ? gate.ratePauseRemainingMs() : gate.pausedRemainingMs();
  if (paused > 0) {
    if (gate.notePauseRefusal()) log(gate.holdReason && !opts.ignoreHold ? `BringUp: logins held — ${gate.holdReason}` : `BringUp: logins paused, ${Math.floor(paused / 1000)}s left — not attempting any account`);
    throw new BringUpRefused("paused", gate.holdReason && !opts.ignoreHold ? "logins held" : "logins paused");
  }
  const locked = gate.lockoutRemainingMs(acc.guid);
  if (locked > 0) {
    log(`BringUp: ${label} login-locked, ${Math.floor(locked / 1000)}s remaining — skipping`);
    throw new BringUpRefused("locked", "login locked");
  }
  if (clients.has(acc.guid)) throw new BringUpRefused("failed", `account ${acc.guid} already added`);

  // Proxy: the pool wins whenever there is one; an account's own proxy is
  // the fallback only when nothing is configured. With the proxy rule on,
  // no pool means no login at all.
  let proxy: Proxy | null = null;
  if (deps.requireProxy?.() && !proxies.configured && !acc.info.proxy?.host) {
    if (gate.notePauseRefusal()) log("BringUp: no proxies listed and logins are set to go through a proxy only — paste some in the console's Proxies tab");
    throw new BringUpRefused("failed", "no proxy: proxies are required");
  }
  if (proxies.configured) {
    proxy = proxies.claim(acc.guid);
    if (!proxy) {
      log(`BringUp: no free proxy for ${label} (${proxies.occupiedCount()} of ${proxies.exclusiveCapacity()} host(s) in use); refusing to share an exit IP`);
      throw new BringUpRefused("failed", "no free proxy", true);
    }
    log(`BringUp: using ${proxy.host}:${proxy.port} for ${label}`);
  } else if (acc.info.proxy?.host) {
    const p = acc.info.proxy;
    const own: Proxy = { host: String(p.host), port: Number(p.port), type: p.type === 4 ? 4 : 5, username: p.username ?? "", password: p.password ?? "" };
    proxy = own;
    log(`BringUp: no proxy pool loaded — ${label} using its configured proxy ${own.host}:${own.port}`);
  }
  // From this computer's own address: one account on that IP at a time
  // (DIRECT_ONLINE_BOTS), whoever asks — the dispatcher, a sweep, the
  // backpack chore, a storage trip.
  if (!proxy) {
    const direct = [...clients.values()].filter((c) => c.active && !c.proxy).length;
    if (direct >= DIRECT_ONLINE_BOTS) {
      log(`BringUp: ${label} would be the ${direct + 1}th account on this computer's own IP (DIRECT_ONLINE_BOTS=${DIRECT_ONLINE_BOTS}); waiting for one to log out`);
      throw new BringUpRefused("failed", "this computer's IP already carries a bot", true);
    }
  }

  const client = new GameClient({
    guid: acc.info.guid,
    password: acc.info.password,
    secret: acc.info.secret,
    alias: acc.alias,
    server: isServerName(server) ? server : DEFAULT_SERVER,
    proxy,
    buildVersion: deps.buildVersion,
    ...(opts.charId !== undefined ? { charId: opts.charId } : acc.info.charId !== undefined ? { charId: acc.info.charId } : {}),
    ...(opts.createSeasonal === undefined && !opts.createForce ? {} : { create: { seasonal: opts.createSeasonal ?? false, ...(opts.createForce ? { force: true } : {}) } }),
  });
  client.on("log", log);
  // Registered before auth so the exit IP and the guid are visibly taken
  // for the whole login, exactly the window a second wake would race.
  clients.set(acc.guid, client);
  const drop = () => {
    if (clients.get(acc.guid) === client) clients.delete(acc.guid);
    proxies.release(acc.guid);
  };
  client.on("stopped", drop);

  // An advanced account keeps its token (tokenCache.ts): a login within the
  // token's lifetime goes straight to char/list. A kept token char/list
  // refuses is spent, which says nothing about the account: it is forgotten
  // and a fresh one minted once, and only that answer counts.
  const advanced = !!deps.isAdvanced?.(acc);
  const exit = exitKey(proxy);
  const kept = advanced ? tokenCache.get(acc.guid, exit) : null;
  let auth: { ok: true } | { ok: false; error: AuthFailure } | null = null;
  if (kept) {
    auth = await client.resume(kept.token, kept.issuedAt);
    if (auth.ok) noteLoginToken("reused");
    else if (tokenSpent(auth.error) && client.active) {
      tokenCache.invalidate(acc.guid);
      noteLoginToken("reuseFailed");
      const said = "body" in auth.error ? auth.error.body : "detail" in auth.error ? auth.error.detail : "";
      log(`BringUp: ${label}'s kept token was refused (${auth.error.kind}${said ? `: ${said.replace(/\s+/g, " ").slice(0, 160)}` : ""}) — minting a fresh one`);
      auth = null;
    }
  }
  if (!auth && client.active) {
    auth = await client.authenticate();
    if (auth.ok) {
      noteLoginToken("minted");
      if (advanced) tokenCache.set(acc.guid, exit, client.token, client.tokenIssuedAt, client.tokenLifetimeS);
    }
  }
  // Stopped while authenticating (evicted, shut down): nothing about the
  // proxy or the account was learned, so nothing is charged to either.
  if (!client.active || !auth) {
    drop();
    throw new BringUpRefused("failed", "stopped during login");
  }
  if (!auth.ok) {
    client.stop();
    const e = auth.error;
    if (proxy && e.kind === "network") proxies.noteResult(proxies.keyOf(proxy), false);
    acc.lastLoginError = {
      at: Date.now(), kind: e.kind,
      message: e.kind === "bad-credentials" ? "Realm did not accept these credentials (the email, the password, or an account that signs in through Steam or another service)" : e.kind === "suspended" ? "Realm says the account is suspended" : e.kind === "attempt-limit" ? "Realm's login attempt limit" : e.kind === "account-in-use" ? `account in use elsewhere (${e.seconds}s)` : e.kind === "network" ? `network error via ${proxy?.host ?? "direct"}: ${e.detail}` : `Realm answered: ${e.body.replace(/\s+/g, " ").slice(0, 120)}`,
    };
    switch (e.kind) {
      case "suspended":
        retireSuspended(deps, acc);
        throw new BringUpRefused("suspended", "account suspended");
      case "attempt-limit":
        gate.noteAttemptLimit(acc.guid, e.lockoutSeconds);
        throw new BringUpRefused("locked", "login attempt limit");
      case "account-in-use":
        gate.noteCooldown(acc.guid, e.seconds, "account in use at char/list");
        throw new BringUpRefused("locked", "account in use");
      case "bad-credentials":
        // No retry until the owner corrects them (Accounts → credentials):
        // a wrong password tried every wake walks into Realm's attempt limit.
        gate.noteBadCredentials(acc.guid);
        tokenCache.invalidate(acc.guid);
        log(`BringUp: ${label} got invalid credentials — not logging it in again until they are corrected`);
        throw new BringUpRefused("failed", "bad credentials");
      case "network":
        log(`BringUp: ${label} auth network error via ${proxy?.host ?? "direct"}: ${e.detail}`);
        throw new BringUpRefused("failed", "auth network error");
      default:
        log(`BringUp: ${label} failed to authenticate: ${e.body.slice(0, 200)}`);
        throw new BringUpRefused("failed", "auth failed");
    }
  }
  acc.lastLoginError = null;
  noteAccountLogin(acc.guid);
  // A look at another character (opts.charId) says nothing about the
  // account's character of record: the roster's season, the tracker's
  // slot count and the login hooks all describe the character it plays.
  const visit = opts.charId !== undefined || opts.createForce === true;
  if (!visit && client.charSeasonal !== null) pool.setSeasonal(acc, client.charSeasonal);
  // char/list (read during authenticate) is the authority on the backpack;
  // the tracker's memory only stands in when there was no character to ask.
  const tracked = (deps.capacityFor?.(acc.botGuid) ?? 8) >= 16;
  if (client.charHasBackpack === null) client.knownBackpack = !visit && tracked;
  else if (!visit && client.charHasBackpack !== tracked) log(`BringUp: ${label} char/list says ${client.charHasBackpack ? "backpack" : "no backpack"} but the tracker had ${tracked ? 16 : 8} slots — trusting char/list`);
  gate.noteLoginSuccess();
  if (!visit) {
    try {
      deps.onLogin?.(acc, client);
    } catch (e) {
      log(`BringUp: onLogin hook failed for ${label}: ${String(e)}`);
    }
  }
  if (proxy) proxies.noteResult(proxies.keyOf(proxy), true);
  // A moved server is resolved here, before the socket opens, not after a
  // release: the token just earned is what account/servers wants.
  if (deps.servers?.stale && client.token) await deps.servers.refreshIfStale(client.token, proxy);

  // Failure packets after this point are policy events for the gate.
  client.on("failure", (ev) => {
    switch (ev.kind) {
      case "token-error":
        gate.noteCooldown(acc.guid, TOKEN_ERROR_COOLDOWN_S, "token security error — next wake re-authenticates");
        tokenCache.invalidate(acc.guid);
        break;
      case "bad-credentials": tokenCache.invalidate(acc.guid); break;
      case "account-in-use": gate.noteCooldown(acc.guid, ev.seconds, `account in use, Realm needs ${ev.seconds}s to release the old session`); break;
      case "rate-limit":
        gate.noteCooldown(acc.guid, ev.seconds, "rate limited");
        if (ev.serverJam) gate.noteServerJam(client.server, 45, "connection limit / full login queue");
        break;
      case "update-client":
        // The server rejected our build: hold every login (the next wakes
        // would only be kicked the same way, a synchronised-kick pattern) and
        // pull the feed now. A newer build from the feed re-applies the build
        // gate, which releases this hold for a known build (or holds it for a
        // canary on an unknown one); the owner can trust or canary meanwhile.
        log(`BringUp: ${label} rejected as outdated build ${deps.buildVersion}; holding logins and re-checking the version feed`);
        gate.hold(`Realm build ${deps.buildVersion} was refused by the server as outdated; waiting for the version feed to name the new build`);
        void deps.refreshBuildVersion?.();
        break;
      case "ip-ban":
        // Realm banned the exit: out of use for a long while, so the next
        // account pinned to it doesn't walk into the same ban.
        if (proxy) proxies.noteBan(proxies.keyOf(proxy));
        log(`BringUp: ${label} IP-banned via ${proxy?.host ?? "this computer's own IP"}`);
        break;
      default: break;
    }
  });

  const connected = await client.connect();
  if (!connected) {
    // A connect cut short by stop() says nothing about the exit.
    const stoppedMeanwhile = !client.active;
    client.stop();
    if (proxy && !stoppedMeanwhile) proxies.noteResult(proxies.keyOf(proxy), false);
    throw new BringUpRefused("failed", "socket connect failed");
  }
  return client;
}

/** A kept token's refusal at char/list that only says the token is spent: mint a fresh one rather than judge the account by it. */
function tokenSpent(e: AuthFailure): boolean {
  return e.kind === "bad-credentials" || e.kind === "unknown";
}

export function retireSuspended(deps: FleetDeps, acc: BotAccount): void {
  deps.gate.retire(acc.guid);
  deps.pool.markSuspended(acc.guid);
  tokenCache.invalidate(acc.guid);
}

/**
 * Tear a client down and stamp the reconnect grace on its account. An
 * advanced account we log out ourselves from a live session gets none:
 * Realm takes such an account back at once (an immediate reconnect was
 * accepted, measured live 2026-10-01). A session that had already dropped
 * keeps the grace, since Realm may still hold it; failure cooldowns are
 * stamped where the failure is read, so they stand either way.
 */
export function takeDown(deps: FleetDeps, acc: BotAccount, why: string): void {
  const client = deps.clients.get(acc.guid);
  const clean = !!client && client.active && client.connected && !!deps.isAdvanced?.(acc);
  if (client) client.stop();
  deps.clients.delete(acc.guid);
  deps.proxies.release(acc.guid);
  if (RECONNECT_GRACE_S > 0 && !clean) deps.gate.noteCooldown(acc.guid, RECONNECT_GRACE_S, `session just closed (${why})`);
}
