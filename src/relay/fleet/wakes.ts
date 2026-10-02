// Login scheduling shared by every dispatcher in the process: the global
// stagger, in-flight logins, per-account retry pacing. One Realm connection
// budget, one place that paces it.
import type { GameClient } from "../client/gameClient";
import type { BotAccount } from "./botPool";
import { bringUp, BringUpRefused, type FleetDeps } from "./bringUp";
import { WAKE_RETRY_COOLDOWN_S, WAKE_STAGGER_S } from "./constants";

export interface WakeResult {
  acc: BotAccount;
  server: string;
  client: GameClient | null;
  verdict: "captured" | "suspended" | "locked" | "paused" | "failed";
}

export class WakeScheduler {
  /** guid -> { at, server } for logins currently running. */
  readonly inflight = new Map<string, { at: number; server: string }>();
  /** guid -> last attempt time that hasn't produced a live client. */
  readonly attempts = new Map<string, number>();
  lastWakeAt = 0;
  lastPullAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: FleetDeps) {}

  stop(): void {
    this.stopped = true;
  }

  waking(): Set<string> {
    return new Set(this.inflight.keys());
  }
  wakingServers(): Map<string, string> {
    return new Map([...this.inflight].map(([g, v]) => [g, v.server]));
  }

  /** Live clients plus logins in flight — what counts against the cap. */
  globalOnline(): number {
    let active = 0;
    for (const c of this.deps.clients.values()) if (c.active) active++;
    return active + this.inflight.size;
  }

  /**
   * Start a login for `acc` on `server`. Returns true when a wake was
   * STARTED (it resolves later through `onResult`), false when refused.
   */
  start(acc: BotAccount, server: string, onResult: (r: WakeResult) => void, log: (s: string) => void): boolean {
    if (this.stopped) return false;
    const now = Date.now();
    const last = this.attempts.get(acc.guid);
    if (last !== undefined) {
      if (acc.online) this.attempts.delete(acc.guid);
      else if (now - last < WAKE_RETRY_COOLDOWN_S * 1000) return false;
    }
    if (this.inflight.has(acc.guid)) return false;
    this.inflight.set(acc.guid, { at: now, server });
    this.attempts.set(acc.guid, now);
    log(`Dispatcher.supervise: waking ${acc.alias} on ${server}`);
    // One login at a time per process, spaced by the global stagger, exactly
    // like the single wake worker it replaces.
    this.queue = this.queue.then(async () => {
      let client: GameClient | null = null;
      let verdict: WakeResult["verdict"] = "failed";
      try {
        const gap = WAKE_STAGGER_S * 1000 - (Date.now() - this.lastWakeAt);
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        if (this.stopped) return;
        this.lastWakeAt = Date.now();
        client = await (this.deps.bringUp ?? bringUp)(this.deps, acc, server);
        verdict = "captured";
        // An advanced account's next login is often moments away (a character
        // switch, its next request): a login that worked is no attempt to pace.
        if (this.deps.isAdvanced?.(acc)) this.attempts.delete(acc.guid);
      } catch (e) {
        if (e instanceof BringUpRefused) verdict = e.verdict;
        else log(`Dispatcher: wake of ${acc.alias} on ${server} raised: ${String(e)}`);
      } finally {
        this.inflight.delete(acc.guid);
        onResult({ acc, server, client, verdict });
      }
    });
    return true;
  }
}
