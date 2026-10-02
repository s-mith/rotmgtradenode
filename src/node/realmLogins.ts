// The hub's login node (docs/hub-protocol.md, "Realm logins"): people sign in
// to the hub website, or prove which character they trade with, by
// whispering a code to this node's login desk. The hub hands this node the
// codes it minted (a long poll, like its request queue); the node registers
// each with the desk, says which bot to whisper, and reports the character
// that sent it back. Only a /tell from a character's own session can carry
// its name, so that is the proof. The hub names one node its login node in
// the heartbeat reply; every other node never asks.
import type { RealmLoginReady, RealmLoginVerified, RealmLoginWire } from "../shared/hubWire";
import type { HubClient } from "./hub";

export const REALM_LOGIN_WAIT_S = 25;
/**
 * How long a code waits for a login desk bot to be in the game before the hub is told none can take it. The desk
 * is staffed on demand unless the owner keeps it on: a waiting code is what brings a bot in, and a login takes a while.
 */
export const DESK_WAIT_MS = Number(process.env.REALM_LOGIN_DESK_WAIT_SECONDS ?? 150) * 1000;
/** Not (or no longer) the login node: look again this often. After a failed call: wait this long. */
const IDLE_CHECK_MS = 10_000;
const BACKOFF_MS = 15_000;
const IGN_RE = /^[A-Za-z]{1,32}$/;

export interface RealmLoginOptions {
  hub: Pick<HubClient, "signed" | "loginNode">;
  /** The login desk's code book: register a code, and hear the moment its tell arrives. */
  codes: { register(code: string, ttlMs?: number): void; onVerified(fn: (code: string, ign: string) => void): () => void };
  /** The bot to name in "/tell <bot> <code>" and its server, or null while none is in the game. */
  desk: () => { ign: string; server: string | null } | null;
  log: (s: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RealmLoginRunner {
  private running = false;
  private off: (() => void) | null = null;
  /** code -> the hub's login id, until its tell arrives or it expires. */
  private pending = new Map<string, { id: number; expiresAt: number }>();
  /** Verified logins the hub has not taken yet (it was unreachable): sent again on the next round. */
  private unsent: { id: number; ign: string }[] = [];
  private lastError: string | null = null;
  private served = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly o: RealmLoginOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  }

  start(): void {
    if (this.running) return;
    this.listen();
    void this.loop();
  }
  /** Hear the desk's tells without the polling loop (the loop calls pollOnce; tests drive it themselves). */
  listen(): void {
    this.running = true;
    this.off ??= this.o.codes.onVerified((code, ign) => void this.verified(code, ign));
  }
  stop(): void {
    this.running = false;
    this.off?.();
    this.off = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (!this.o.hub.loginNode) {
        await this.sleep(IDLE_CHECK_MS);
        continue;
      }
      const began = this.now();
      const n = await this.pollOnce(REALM_LOGIN_WAIT_S).catch(() => null);
      if (n === null && this.running) await this.sleep(BACKOFF_MS);
      // A hub that answers an empty queue at once (it does not hold the call) is asked again after a pause, not in a spin.
      else if (n === 0 && this.now() - began < 1_000) await this.sleep(5_000);
    }
  }

  /** One round: send what is owed, take what the hub has queued (waiting up to `waitS` for some), hand each code to the desk. Null when the hub could not be asked. */
  async pollOnce(waitS = 0): Promise<number | null> {
    await this.flushUnsent();
    const now = this.now();
    for (const [code, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(code);
    const r = await this.o.hub.signed<{ logins: RealmLoginWire[] }>("GET", `/api/v1/realm-logins/pending${waitS > 0 ? `?wait=${waitS}` : ""}`, undefined, { timeoutMs: (waitS + 10) * 1000 });
    if (!r.ok) {
      this.lastError = r.error;
      return null;
    }
    this.lastError = null;
    // Each code waits for a desk on its own: one that has to wait for a bot to log in holds up none of the others.
    for (const l of r.data.logins) void this.take(l).catch((e) => this.o.log(`realm login: code #${l.id} failed: ${String(e)}`));
    return r.data.logins.length;
  }

  /** Register a code with the desk and tell the hub which bot to whisper (or that none can take it). Resolves once the hub has the answer. */
  async take(l: RealmLoginWire): Promise<void> {
    const start = this.now();
    this.pending.set(l.code, { id: l.id, expiresAt: l.expiresAt });
    this.o.codes.register(l.code, l.expiresAt - start);
    let desk = this.o.desk();
    while (!desk && this.running && this.now() - start < DESK_WAIT_MS) {
      await this.sleep(2_000);
      desk = this.o.desk();
    }
    const body: RealmLoginReady = desk ? { botIgn: desk.ign, server: desk.server } : { error: "no login bot could get into the game in time; try again in a few minutes" };
    if (!desk) this.pending.delete(l.code);
    const r = await this.o.hub.signed("POST", `/api/v1/realm-logins/${l.id}/ready`, body);
    if (!r.ok) this.o.log(`realm login: could not tell the hub about code #${l.id}: ${r.error}`);
    else this.o.log(desk ? `realm login: code #${l.id} waits at ${desk.ign}${desk.server ? ` on ${desk.server}` : ""}` : `realm login: no login desk bot for code #${l.id}`);
  }

  /** A tell carried one of the hub's codes: report the character that sent it. */
  private async verified(code: string, sender: string): Promise<void> {
    const p = this.pending.get(code);
    if (!p) return;
    this.pending.delete(code);
    // Realm writes some names as "Name,1a2b" on the wire; the hub wants the name.
    const ign = sender.split(",", 1)[0].trim();
    if (!IGN_RE.test(ign)) {
      this.o.log(`realm login: code #${p.id} came from a name that is not a character name; ignored`);
      return;
    }
    this.served++;
    this.unsent.push({ id: p.id, ign });
    await this.flushUnsent();
  }
  private async flushUnsent(): Promise<void> {
    const due = this.unsent;
    this.unsent = [];
    for (const v of due) {
      const r = await this.o.hub.signed("POST", `/api/v1/realm-logins/${v.id}/verified`, { ign: v.ign } satisfies RealmLoginVerified);
      if (r.ok) this.o.log(`realm login: ${v.ign} whispered code #${v.id}`);
      else if (r.status === 0 || r.status >= 500) this.unsent.push(v);
      else this.o.log(`realm login: the hub refused code #${v.id}: ${r.error}`);
    }
  }

  status(): { active: boolean; pending: number; served: number; lastError: string | null } {
    return { active: this.running && this.o.hub.loginNode, pending: this.pending.size, served: this.served, lastError: this.lastError };
  }
}
