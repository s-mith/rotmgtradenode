// "Retry suspended": the roster marks an account suspended the moment Realm
// says so at login, and never looks again. Bans get lifted, and a login
// hiccup can be misread, so the owner can ask for a re-check: an HTTP
// verify (token + char/list, the same pair the login uses) through a proxy,
// no game session. An account Realm now accepts is un-retired and may log
// in again; one still refused stays put. The login gate is respected as for a
// login: nothing is asked while logins are paused after Realm's attempt
// limit or while the account waits out a cooldown of its own, and an attempt
// limit met here counts at the gate.
import type { Proxy } from "../net/proxy";
import { clientTokenFor, getAccessToken, getCharList } from "../realm/api";
import type { BotAccount, BotPool } from "./botPool";
import { LOCKOUT_WAIT_MS } from "./borrow";
import type { LoginGate } from "./loginGate";
import type { ProxyPool } from "./proxyPool";

export type RetryVerdict = "cleared" | "still-suspended" | "bad-credentials" | "attempt-limit" | "error";
export interface RetryResult {
  alias: string;
  guid: string;
  botGuid: string;
  verdict: RetryVerdict;
  detail: string;
}

export interface RetryDeps {
  pool: BotPool;
  gate: LoginGate;
  proxies: ProxyPool;
  requireProxy: () => boolean;
  log: (s: string) => void;
  /** Test hook: replaces the two HTTP calls. */
  verify?: (acc: BotAccount, proxy: Proxy | null) => Promise<RetryVerdict | { verdict: RetryVerdict; detail: string; lockoutSeconds?: number }>;
}

async function verifyOnce(acc: BotAccount, proxy: Proxy | null): Promise<{ verdict: RetryVerdict; detail: string; lockoutSeconds?: number }> {
  const password = acc.info.password ?? "";
  const tok = await getAccessToken({ guid: acc.guid, password, secret: acc.info.secret }, clientTokenFor(acc.guid, password), proxy);
  if (!tok.ok) {
    const e = tok.error;
    if (e.kind === "suspended") return { verdict: "still-suspended", detail: "Realm: suspended at verify" };
    if (e.kind === "bad-credentials") return { verdict: "bad-credentials", detail: "Realm: invalid credentials" };
    if (e.kind === "attempt-limit") return { verdict: "attempt-limit", detail: `login attempt limit, wait ${e.lockoutSeconds}s`, lockoutSeconds: e.lockoutSeconds };
    return { verdict: "error", detail: e.kind === "network" ? `network: ${e.detail}` : `verify failed: ${e.kind}` };
  }
  // A token can still be issued for a suspended account; char/list is where the suspension shows.
  const chars = await getCharList(tok.value, proxy);
  if (!chars.ok) {
    const e = chars.error;
    if (e.kind === "suspended") return { verdict: "still-suspended", detail: "Realm: suspended at char/list" };
    return { verdict: "error", detail: e.kind === "network" ? `network: ${e.detail}` : `char/list failed: ${e.kind}` };
  }
  return { verdict: "cleared", detail: `Realm accepts the account (${chars.value.charIds.length} character(s))` };
}

/**
 * Re-check every suspended account (or just `guids`), one per exit IP at a
 * time: as many at once as there are enabled proxy hosts (each check holds
 * its host), or one from this computer's own address without a proxy list.
 */
export async function retrySuspended(deps: RetryDeps, guids?: string[], concurrency = Math.max(1, deps.proxies.exclusiveCapacity() ?? 1)): Promise<RetryResult[]> {
  const targets = deps.pool.every().filter((a) => a.suspended && (!guids?.length || guids.includes(a.guid) || guids.includes(a.botGuid)));
  if (!targets.length) return [];
  if (deps.requireProxy() && !deps.proxies.configured) {
    return targets.map((a) => ({ alias: a.alias, guid: a.guid, botGuid: a.botGuid, verdict: "error" as const, detail: "no proxies listed and logins are set to go through a proxy only" }));
  }
  const out: RetryResult[] = [];
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const acc = targets[i++];
      // The gate first: a pause may start while the run goes (an attempt limit met by another check).
      const paused = deps.gate.ratePauseRemainingMs();
      const cooling = deps.gate.cooldownRemainingMs(acc.guid);
      if (paused > 0 || cooling > 0) {
        const detail = paused > 0 ? `logins are paused for another ${Math.ceil(paused / 1000)}s after Realm's login attempt limit` : `the account waits out a login cooldown (${Math.ceil(cooling / 1000)}s left)`;
        deps.log(`retry: ${acc.alias} not checked: ${detail}`);
        out.push({ alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, verdict: "error", detail });
        continue;
      }
      // With a proxy list the check never goes out from this computer's own
      // address: while every host carries a bot, it waits for one to come
      // free as long as a storage read would.
      const proxy = deps.proxies.configured ? await deps.proxies.probeWhenFree(acc.guid, Date.now() + LOCKOUT_WAIT_MS) : null;
      let r: { verdict: RetryVerdict; detail: string; lockoutSeconds?: number };
      if (deps.proxies.configured && !proxy) {
        r = { verdict: "error", detail: `no free proxy: ${deps.proxies.noFreeHostReason()}` };
      } else {
        try {
          const v = deps.verify ? await deps.verify(acc, proxy) : await verifyOnce(acc, proxy);
          r = typeof v === "string" ? { verdict: v, detail: "" } : v;
        } catch (e) {
          r = { verdict: "error", detail: String(e) };
        } finally {
          deps.proxies.releaseProbe(acc.guid);
        }
      }
      if (r.verdict === "attempt-limit" && r.lockoutSeconds) deps.gate.noteAttemptLimit(acc.guid, r.lockoutSeconds);
      if (r.verdict === "cleared") {
        deps.pool.clearSuspended(acc.guid);
        deps.gate.unlock(acc.guid);
        deps.log(`retry: ${acc.alias} is no longer suspended — back in the roster`);
      } else {
        deps.log(`retry: ${acc.alias} ${r.verdict}${r.detail ? ` (${r.detail})` : ""}`);
      }
      out.push({ alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, verdict: r.verdict, detail: r.detail });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return out;
}
