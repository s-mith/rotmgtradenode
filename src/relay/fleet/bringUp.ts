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
import { RECONNECT_GRACE_S, TOKEN_ERROR_COOLDOWN_S } from "./constants";

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
}

export class BringUpRefused extends Error {
  constructor(readonly verdict: BringUpVerdict, message: string) {
    super(message);
  }
}

/**
 * Create, authenticate and connect a client for `acc` on `server`.
 * Resolves with the client, or rejects with BringUpRefused carrying the
 * verdict. Everything short of a live client releases the exit IP.
 */
export interface BringUpOptions {
  /** When the account has no character, CREATE one with this seasonality. Default: non-seasonal. */
  createSeasonal?: boolean;
  /** The build gate's canary: go past a standing hold (never past a rate-limit pause). */
  ignoreHold?: boolean;
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
      throw new BringUpRefused("failed", "no free proxy");
    }
    log(`BringUp: using ${proxy.host}:${proxy.port} for ${label}`);
  } else if (acc.info.proxy?.host) {
    const p = acc.info.proxy;
    const own: Proxy = { host: String(p.host), port: Number(p.port), type: p.type === 4 ? 4 : 5, username: p.username ?? "", password: p.password ?? "" };
    proxy = own;
    log(`BringUp: no proxy pool loaded — ${label} using its configured proxy ${own.host}:${own.port}`);
  }

  const client = new GameClient({
    guid: acc.info.guid,
    password: acc.info.password,
    secret: acc.info.secret,
    alias: acc.alias,
    server: isServerName(server) ? server : DEFAULT_SERVER,
    proxy,
    buildVersion: deps.buildVersion,
    ...(acc.info.charId !== undefined ? { charId: acc.info.charId } : {}),
    ...(opts.createSeasonal === undefined ? {} : { tutorial: { seasonal: opts.createSeasonal } }),
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

  const auth = await client.authenticate();
  if (!auth.ok) {
    client.stop();
    const e = auth.error;
    if (proxy && e.kind === "network") proxies.noteResult(proxy.host, false);
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
        log(`BringUp: ${label} got invalid credentials`);
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
  if (client.charSeasonal !== null) pool.setSeasonal(acc, client.charSeasonal);
  // char/list (read during authenticate) is the authority on the backpack;
  // the tracker's memory only stands in when there was no character to ask.
  const tracked = (deps.capacityFor?.(acc.botGuid) ?? 8) >= 16;
  if (client.charHasBackpack === null) client.knownBackpack = tracked;
  else if (client.charHasBackpack !== tracked) log(`BringUp: ${label} char/list says ${client.charHasBackpack ? "backpack" : "no backpack"} but the tracker had ${tracked ? 16 : 8} slots — trusting char/list`);
  gate.noteLoginSuccess();
  try {
    deps.onLogin?.(acc, client);
  } catch (e) {
    log(`BringUp: onLogin hook failed for ${label}: ${String(e)}`);
  }
  if (proxy) proxies.noteResult(proxy.host, true);
  // A moved server is resolved here, before the socket opens, not after a
  // release: the token just earned is what account/servers wants.
  if (deps.servers?.stale && client.token) await deps.servers.refreshIfStale(client.token, proxy);

  // Failure packets after this point are policy events for the gate.
  client.on("failure", (ev) => {
    switch (ev.kind) {
      case "token-error": gate.noteCooldown(acc.guid, TOKEN_ERROR_COOLDOWN_S, "token security error — next wake re-authenticates"); break;
      case "account-in-use": gate.noteCooldown(acc.guid, ev.seconds, `account in use, Realm needs ${ev.seconds}s to release the old session`); break;
      case "rate-limit":
        gate.noteCooldown(acc.guid, ev.seconds, "rate limited");
        if (ev.serverJam) gate.noteServerJam(client.server, 45, "connection limit / full login queue");
        break;
      case "update-client":
        // The server rejected our build: pull the feed before the next wake
        // instead of waiting out the poll interval.
        log(`BringUp: ${label} rejected as outdated build ${deps.buildVersion}; re-checking the version feed`);
        void deps.refreshBuildVersion?.();
        break;
      default: break;
    }
  });

  const connected = await client.connect();
  if (!connected) {
    client.stop();
    if (proxy) proxies.noteResult(proxy.host, false);
    throw new BringUpRefused("failed", "socket connect failed");
  }
  return client;
}

export function retireSuspended(deps: FleetDeps, acc: BotAccount): void {
  deps.gate.retire(acc.guid);
  deps.pool.markSuspended(acc.guid);
}

/** Tear a client down and stamp the reconnect grace on its account. */
export function takeDown(deps: FleetDeps, acc: BotAccount, why: string): void {
  const client = deps.clients.get(acc.guid);
  if (client) client.stop();
  deps.clients.delete(acc.guid);
  deps.proxies.release(acc.guid);
  if (RECONNECT_GRACE_S > 0) deps.gate.noteCooldown(acc.guid, RECONNECT_GRACE_S, `session just closed (${why})`);
}
