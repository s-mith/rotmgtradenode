// Taking an account away from the dispatcher for a maintenance login (a
// storage trip, a read of a new account): hold the guid so the desk leaves
// it alone, have the desk let go of it when it is idling there, let a login
// in progress finish, wait out the gate's cooldown after the closed session,
// and hand it back afterwards. Used by storage.ts and Fleet.readAccount.
import type { BotAccount } from "./botPool";
import type { SweepDeps } from "./sweeps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long to wait for a lent bot to go offline, and for its login cooldown to pass. */
export const RELEASE_WAIT_MS = 15_000;
export const LOCKOUT_WAIT_MS = 90_000;

export interface BorrowOptions {
  sd: SweepDeps;
  /** Guids the dispatcher must leave alone while borrowed. */
  holds: Set<string>;
  /** Ask the dispatcher to let go of an idle online bot (it disconnects it); false when the bot is busy. */
  release?: (acc: BotAccount) => boolean;
  /** A label for the console while waiting; null when done. */
  activity?: (label: string | null) => void;
  cancelled?: () => boolean;
  now?: () => number;
}
export type BorrowRefusal = "busy" | "login in progress" | "the desk did not let go" | "login-locked" | "the desk kept taking the account back";
export type Borrowed = { ok: true; giveBack: () => void } | { ok: false; why: BorrowRefusal };

/**
 * Resolve to `ok` with the account offline, held, and clear of the gate; the
 * caller logs it in itself and calls giveBack() when done (which also drops
 * the hold). Refusals leave nothing held.
 */
export async function borrowAccount(acc: BotAccount, o: BorrowOptions): Promise<Borrowed> {
  const { sd, holds } = o;
  const now = o.now ?? Date.now;
  const cancelled = o.cancelled ?? (() => false);
  if (acc.assignedRequestId !== null || acc.inUse) return { ok: false, why: "busy" };
  holds.add(acc.guid);
  const refuse = (why: BorrowRefusal): Borrowed => {
    holds.delete(acc.guid);
    o.activity?.(null);
    return { ok: false, why };
  };
  for (let attempt = 1; ; attempt++) {
    // A login in progress (the fleet's client map holds the guid before the client is active) is left to finish first.
    if (!(acc.client && acc.client.active) && sd.deps.clients.has(acc.guid)) {
      o.activity?.("waiting for a login in progress");
      const settle = now() + RELEASE_WAIT_MS * 2;
      while (!(acc.client && acc.client.active) && sd.deps.clients.has(acc.guid) && now() < settle) await sleep(250);
      if (!(acc.client && acc.client.active) && sd.deps.clients.has(acc.guid)) return refuse("login in progress");
    }
    if (acc.client && acc.client.active) {
      o.activity?.("waiting for the desk to let go");
      if (!(o.release?.(acc) ?? false)) return refuse("busy");
      const until = now() + RELEASE_WAIT_MS;
      while (acc.client && acc.client.active && now() < until) await sleep(250);
      if (acc.client && acc.client.active) return refuse("the desk did not let go");
    }
    o.activity?.("waiting for the login cooldown");
    const lockUntil = now() + LOCKOUT_WAIT_MS;
    while ((sd.deps.gate.lockoutRemainingMs(acc.guid) > 0 || sd.deps.gate.pausedRemainingMs() > 0) && now() < lockUntil && !cancelled()) await sleep(500);
    if (sd.deps.gate.lockoutRemainingMs(acc.guid) > 0 || sd.deps.gate.pausedRemainingMs() > 0) return refuse("login-locked");
    if (!(acc.client && acc.client.active) && !sd.deps.clients.has(acc.guid)) break;
    if (attempt >= 2) return refuse("the desk kept taking the account back");
  }
  return { ok: true, giveBack: () => { holds.delete(acc.guid); o.activity?.(null); } };
}
