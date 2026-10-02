// The first-run setup the desktop app walks a new owner through (scratchpad
// contract "Windows-ready node"): which steps are done, a check of the
// proxies, and a test login that says in plain words whether a bot gets
// into the game. The owner's progress lives in node settings (`setup`); the
// test and the proxy checks are this run's only.
import type { Fleet } from "../relay/fleet/fleet";
import type { BotAccount } from "../relay/fleet/botPool";
import type { GameClient, FailureEvent } from "../relay/client/gameClient";
import { borrowAccount, type BorrowRefusal } from "../relay/fleet/borrow";
import { bringUp, BringUpRefused, takeDown } from "../relay/fleet/bringUp";
import { checkProxies, type ProxyCheck, type ProxyCheckTargets } from "../relay/net/proxy";
import { DEFAULT_SERVER, GAME_PORT, GameId, SERVER_IPS, isServerName } from "../relay/realm/constants";

export type TestLogin = { state: "running" | "ok" | "failed"; account: string; ign?: string; server?: string; message: string; at: number };
export interface SetupView {
  ok: true;
  complete: boolean;
  steps: {
    accounts: { done: boolean; count: number; ready: number };
    connection: { done: boolean; mode: "proxies" | "own" | "none"; proxies: number; working: number | null };
    hub: { done: boolean; linked: boolean; skipped: boolean };
    test: { done: boolean; last: TestLogin | null };
  };
}
/** One proxy check as the console shows it: `host` is the key the proxy list uses, `display` its address. */
export type ProxyTestResult = ProxyCheck & { display: string };

/** How long the test waits for a bot in the game after the login went through. */
export const TEST_IN_WORLD_MS = Number(process.env.SETUP_TEST_IN_WORLD_SECONDS ?? 45) * 1000;
/** How long the test waits for a job already using the account (the first look at a new account's items). */
export const TEST_WAIT_BUSY_MS = Number(process.env.SETUP_TEST_WAIT_SECONDS ?? 180) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What Realm or the connection said, as a sentence for the owner. `who`: the account's name. */
export function plainLoginError(kind: string, message: string, who: string): string {
  switch (kind) {
    case "bad-credentials": return `Realm says the email or password for ${who} is wrong. Fix them on the Accounts page.`;
    case "suspended": return `Realm has banned ${who} (suspended). Remove it and add a different account.`;
    case "attempt-limit":
    case "rate-limit": return "Realm is limiting logins right now. Wait a few minutes and try again.";
    case "account-in-use": return `${who} is logged in somewhere else (maybe the game is open with it). Close it there and try again in a minute.`;
    case "network": return /via direct/i.test(message)
      ? "Couldn't reach Realm. Check that this computer is online; if it is, Realm may be down for a while."
      : "Couldn't connect through the proxy. Test your proxies and replace the ones that fail.";
    default: {
      const said = message.replace(/^Realm answered:\s*/i, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
      return said ? `Realm turned the login away (“${said}”). Try again in a few minutes.` : "The login didn't work. Try again in a few minutes.";
    }
  }
}

/** A game server's FAILURE during the test, in words. */
function plainFailure(ev: FailureEvent, who: string, direct: boolean): string {
  switch (ev.kind) {
    case "ip-ban": return direct ? "Realm has blocked this computer's internet address for now. Use proxies instead." : "Realm has blocked this proxy's address. Replace it with a different proxy.";
    case "account-in-use": return plainLoginError("account-in-use", "", who);
    case "rate-limit": return plainLoginError("rate-limit", "", who);
    case "bad-credentials": return plainLoginError("bad-credentials", "", who);
    case "update-client":
    case "bad-message": return "Realm updated the game. The node waits until it can use the new version; the status at the top says when.";
    case "token-error": return "Realm didn't accept the login this time. Try again in a minute.";
    default: return plainLoginError("other", ev.description, who);
  }
}

export class SetupService {
  private last: TestLogin | null = null;
  private running = false;
  /** The newest check of each listed proxy, by the list's key; `fp` tells a re-listed proxy with other credentials apart. */
  private readonly checks = new Map<string, { fp: string; ok: boolean; at: number }>();
  /** Where the proxy check connects to; tests point it at local listeners. */
  checkTargets: () => ProxyCheckTargets;

  constructor(private readonly fleet: Fleet) {
    this.checkTargets = () => ({
      web: { host: "www.realmofthemadgod.com", port: 443 },
      game: { host: fleet.servers.status().servers[DEFAULT_SERVER] ?? SERVER_IPS[DEFAULT_SERVER], port: GAME_PORT },
      timeoutMs: 10_000,
      slowMs: 8_000,
    });
  }

  /**
   * Once at start: a node that ran before the first-run setup existed and
   * already has accounts and a way to connect counts as set up, so its owner
   * never meets the wizard. Either way the record is written now, so later
   * starts know this node has met the setup.
   */
  adoptExisting(): void {
    const store = this.fleet.nodeSettings;
    if (!store.setupWasMissing || store.get().setup.completedAt !== null) return;
    const ready = this.fleet.pool.every().length > 0 && (this.fleet.proxies.configured || !store.get().proxies.required);
    store.update((s) => {
      if (ready) s.setup.completedAt = Date.now();
    });
    if (ready) this.fleet.log("setup: this node already has accounts and a way to connect, so it counts as set up");
  }

  private fingerprint(p: { host: string; port: number; username: string; password: string }): string {
    return `${p.host}:${p.port}:${p.username}:${p.password}`;
  }
  /** Listed proxies with a check on record, and how many of those worked. */
  private proxyTally(): { checked: number; working: number } {
    let checked = 0, working = 0;
    for (const e of this.fleet.proxies.entriesFor()) {
      const c = this.checks.get(e.key);
      if (!c || c.fp !== this.fingerprint(e.proxy)) continue;
      checked++;
      if (c.ok) working++;
    }
    return { checked, working };
  }
  /** Hosts (the list's keys) whose newest check is on record. */
  proxyChecks(): Map<string, { ok: boolean; at: number }> {
    const out = new Map<string, { ok: boolean; at: number }>();
    for (const e of this.fleet.proxies.entriesFor()) {
      const c = this.checks.get(e.key);
      if (c && c.fp === this.fingerprint(e.proxy)) out.set(e.key, { ok: c.ok, at: c.at });
    }
    return out;
  }

  view(): SetupView {
    const { fleet } = this;
    const s = fleet.nodeSettings.get();
    const accounts = fleet.pool.every();
    const ready = accounts.filter((a) => !a.suspended && !fleet.gate.isRetired(a.guid) && !fleet.gate.hasBadCredentials(a.guid)).length;
    const listed = fleet.proxies.entriesFor().length;
    const enabled = fleet.proxies.healthReport().filter((h) => h.enabled).length;
    const mode = listed > 0 ? "proxies" : !s.proxies.required ? "own" : "none";
    const tally = this.proxyTally();
    // Proxies count once at least one is switched on, unless every one of them was tested and none worked.
    const connected = mode === "own" || (mode === "proxies" && enabled > 0 && !(tally.checked === listed && tally.working === 0));
    const linked = fleet.hub.linked;
    return {
      ok: true,
      complete: s.setup.completedAt !== null,
      steps: {
        accounts: { done: ready > 0, count: accounts.length, ready },
        connection: { done: connected, mode, proxies: listed, working: tally.checked ? tally.working : null },
        hub: { done: linked || s.setup.hubSkipped, linked, skipped: s.setup.hubSkipped },
        test: { done: this.last?.state === "ok", last: this.last },
      },
    };
  }

  complete(): SetupView {
    this.fleet.nodeSettings.update((s) => {
      s.setup.completedAt = Date.now();
    });
    this.fleet.log("setup: finished");
    return this.view();
  }
  skipHub(): SetupView {
    this.fleet.nodeSettings.update((s) => {
      s.setup.hubSkipped = true;
    });
    return this.view();
  }
  /** Start the setup over (the wizard shows again); nothing else changes. */
  reset(): SetupView {
    this.fleet.nodeSettings.update((s) => {
      s.setup = { completedAt: null, hubSkipped: false };
    });
    this.last = null;
    this.fleet.log("setup: started over");
    return this.view();
  }

  /** Check listed proxies (all of them when `hosts` is empty), 4 at a time. */
  async testProxies(hosts: string[] = []): Promise<ProxyTestResult[]> {
    const entries = this.fleet.proxies.entriesFor(hosts);
    const results = await checkProxies(entries.map((e) => e.proxy), this.checkTargets(), 4);
    const at = Date.now();
    return results.map((r, i) => {
      const e = entries[i];
      this.checks.set(e.key, { fp: this.fingerprint(e.proxy), ok: r.ok, at });
      return { ...r, host: e.key, display: `${e.proxy.host}:${e.proxy.port}` };
    });
  }

  /** The account a test logs in with when none is named: one in the game already, else an idle one free to log in. */
  private pick(): BotAccount | null {
    const { gate } = this.fleet;
    const usable = this.fleet.pool.every().filter((a) => !a.suspended && !gate.isRetired(a.guid) && !gate.hasBadCredentials(a.guid));
    const inWorld = (a: BotAccount) => {
      const c = a.client?.active ? a.client : this.fleet.clients.get(a.guid);
      return !!c && c.active && c.objectId !== -1;
    };
    return usable.find(inWorld)
      ?? usable.find((a) => !a.online && !a.inUse && a.assignedRequestId === null && gate.lockoutRemainingMs(a.guid) === 0)
      ?? usable[0] ?? this.fleet.pool.every()[0] ?? null;
  }

  /** Start a test login in the background; `view().steps.test.last` follows it. */
  startTest(guid?: string): { ok: true } | { ok: false; status: 404 | 409; error: string } {
    if (this.running) return { ok: false, status: 409, error: "A test login is already running. Wait for it to finish." };
    const acc = guid ? this.fleet.pool.every().find((a) => a.guid === guid || a.botGuid === guid) : this.pick();
    if (!acc) return guid ? { ok: false, status: 404, error: "That account isn't on this node." } : { ok: false, status: 409, error: "Add an account first." };
    if (this.view().steps.connection.mode === "none") return { ok: false, status: 409, error: "Set up how your bots connect first: proxies, or your own internet." };
    this.running = true;
    const account = acc.alias;
    this.last = { state: "running", account, message: `Logging ${account} in…`, at: Date.now() };
    void this.attempt(acc)
      .catch((e) => {
        this.fleet.log(`setup: test login of ${account} failed: ${String(e)}`);
        return this.failed(account, "Something went wrong during the test login. Try again.");
      })
      .then((r) => {
        this.last = r;
        this.running = false;
        this.fleet.log(`setup: test login of ${account}: ${r.state === "ok" ? "in the game" : "failed"} (${r.message})`);
      });
    return { ok: true };
  }

  private failed(account: string, message: string): TestLogin {
    return { state: "failed", account, message, at: Date.now() };
  }
  private progress(message: string): void {
    if (this.last?.state === "running") this.last = { ...this.last, message };
  }
  /** Why logins can't go now, when the whole node is held or paused. */
  private pausedMessage(): string | null {
    const g = this.fleet.gate;
    if (g.holdReason) return "Realm updated the game. The node waits until it can use the new version; the status at the top says when.";
    if (g.ratePauseRemainingMs() > 0) return plainLoginError("rate-limit", "", "");
    return null;
  }
  private liveClient(acc: BotAccount): GameClient | null {
    const c = acc.client?.active ? acc.client : this.fleet.clients.get(acc.guid);
    return c && c.active ? c : null;
  }

  private async attempt(acc: BotAccount): Promise<TestLogin> {
    const { fleet } = this;
    const who = acc.alias;
    const startedAt = Date.now();
    const okIn = (client: GameClient, now: boolean): TestLogin => {
      const ign = client.playerData.name;
      if (ign) fleet.tracker.recordIgn(acc.botGuid, ign);
      const where = client.gameIdValue === GameId.vault ? "in its Vault" : "in the Nexus";
      const name = ign || who;
      return { state: "ok", account: who, ...(ign ? { ign } : {}), server: client.server, message: now ? `${name} is in the game on ${client.server} right now.` : `${name} is standing ${where} on ${client.server}.`, at: Date.now() };
    };
    const inWorld = (c: GameClient | null) => !!c && c.objectId !== -1 && !!c.playerData.name;
    // A bot of this account in the game already: the way in works.
    if (inWorld(this.liveClient(acc))) return okIn(this.liveClient(acc)!, true);
    if (acc.suspended || fleet.gate.isRetired(acc.guid)) return this.failed(who, plainLoginError("suspended", "", who));
    if (fleet.gate.hasBadCredentials(acc.guid)) return this.failed(who, plainLoginError("bad-credentials", "", who));
    const paused = this.pausedMessage();
    if (paused) return this.failed(who, paused);

    // A job using the account (the first look at a new account's items) goes first.
    const holds = fleet.dispatcher?.maintenanceHolds ?? new Set<string>();
    const until = Date.now() + TEST_WAIT_BUSY_MS;
    while ((holds.has(acc.guid) || fleet.clients.has(acc.guid)) && !acc.client?.active && Date.now() < until) {
      if (inWorld(this.liveClient(acc))) return okIn(this.liveClient(acc)!, true);
      this.progress(`Waiting for ${who} to finish what it is doing…`);
      await sleep(500);
    }
    if (inWorld(this.liveClient(acc))) return okIn(this.liveClient(acc)!, true);
    // Still held by a job (or by a trip on the bot the dispatcher has online): not this test's to take.
    if (holds.has(acc.guid)) return this.failed(who, `${who} is busy right now. Try again in a minute.`);

    this.progress(`Logging ${who} in…`);
    const lent = await borrowAccount(acc, {
      sd: fleet.sweepDeps, holds,
      release: (a) => fleet.dispatcher?.releaseForMaintenance(a) ?? true,
      activity: (label) => label && this.progress(`${who}: ${label}…`),
    });
    if (!lent.ok) return this.failed(who, this.refusal(acc, lent.why));
    try {
      let client: GameClient;
      try {
        client = await (fleet.deps.bringUp ?? bringUp)(fleet.deps, acc, acc.info.server && isServerName(acc.info.server) ? acc.info.server : DEFAULT_SERVER);
      } catch (e) {
        return this.failed(who, this.bringUpError(acc, e, startedAt));
      }
      this.progress(`${who} logged in; entering the game…`);
      const direct = !client.proxy;
      const outcome = await new Promise<TestLogin>((resolve) => {
        const timer = setTimeout(() => done(this.failed(who, "The bot logged in but didn't get into the game in time. Try again; if it keeps happening, the proxy may be too slow.")), TEST_IN_WORLD_MS);
        const done = (r: TestLogin) => {
          clearTimeout(timer);
          client.off("failure", onFailure);
          client.off("stopped", onStopped);
          client.off("inWorld", onInWorld);
          resolve(r);
        };
        const onFailure = (ev: FailureEvent) => done(this.failed(who, plainFailure(ev, who, direct)));
        const onStopped = () => done(this.failed(who, "The game closed the connection before the bot got in. Try again in a minute."));
        const onInWorld = () => {
          if (client.gameIdValue === GameId.tutorial) done(this.failed(who, `${who} hasn't finished the game's tutorial. Play it to the end in the game, then test again.`));
          else if (client.playerData.name) done(okIn(client, false));
          // The name arrives with the first update; give it a moment.
          else setTimeout(() => done(okIn(client, false)), 1_000);
        };
        client.on("failure", onFailure);
        client.on("stopped", onStopped);
        client.on("inWorld", onInWorld);
        if (client.objectId !== -1) onInWorld();
      });
      takeDown(fleet.deps, acc, "setup test login done");
      return outcome;
    } finally {
      lent.giveBack();
    }
  }

  private refusal(acc: BotAccount, why: BorrowRefusal): string {
    const who = acc.alias;
    if (why === "busy") return `${who} is busy with a trade right now. Try again when it is done.`;
    if (why === "login-locked") {
      if (this.fleet.gate.hasBadCredentials(acc.guid)) return plainLoginError("bad-credentials", "", who);
      if (this.fleet.gate.isRetired(acc.guid)) return plainLoginError("suspended", "", who);
      return this.pausedMessage() ?? `${who} has to wait a little before it can log in again (Realm wants a pause between logins). Try again in a few minutes.`;
    }
    return `${who} is busy right now. Try again in a minute.`;
  }

  private bringUpError(acc: BotAccount, e: unknown, since: number): string {
    const who = acc.alias;
    const fresh = acc.lastLoginError && acc.lastLoginError.at >= since ? acc.lastLoginError : null;
    if (fresh) return plainLoginError(fresh.kind, fresh.message, who);
    if (!(e instanceof BringUpRefused)) return "The login didn't work. Try again in a minute.";
    if (e.verdict === "paused") return this.pausedMessage() ?? plainLoginError("rate-limit", "", who);
    if (e.verdict === "locked") return this.refusal(acc, "login-locked");
    if (e.verdict === "suspended") return plainLoginError("suspended", "", who);
    if (/proxies are required/.test(e.message)) return "Set up how your bots connect first: proxies, or your own internet.";
    if (/no free proxy/.test(e.message)) return "Every proxy is in use by another bot right now. Try again in a minute, or add more proxies.";
    if (/own IP|computer's IP/.test(e.message)) return "Another bot is using your own internet right now (only one can at a time). Try again when it logs out.";
    return "The login didn't work. Try again in a minute.";
  }
}
