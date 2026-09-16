// "Retry suspended": the roster marks an account suspended the moment Realm
// says so at login, and never looks again. Bans get lifted, and a login
// hiccup can be misread, so the owner can ask for a re-check: an HTTP
// verify (token + char/list, the same pair the login uses) through a proxy,
// no game session. An account Realm now accepts is un-retired and may log
// in again; one still refused stays put.
import type { Proxy } from "../net/proxy";
import { clientTokenFor, getAccessToken, getCharList } from "../realm/api";
import type { BotAccount, BotPool } from "./botPool";
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
  verify?: (acc: BotAccount, proxy: Proxy | null) => Promise<RetryVerdict | { verdict: RetryVerdict; detail: string }>;
}

async function verifyOnce(acc: BotAccount, proxy: Proxy | null): Promise<{ verdict: RetryVerdict; detail: string }> {
  const password = acc.info.password ?? "";
  const tok = await getAccessToken({ guid: acc.guid, password, secret: acc.info.secret }, clientTokenFor(acc.guid, password), proxy);
  if (!tok.ok) {
    const e = tok.error;
    if (e.kind === "suspended") return { verdict: "still-suspended", detail: "Realm: suspended at verify" };
    if (e.kind === "bad-credentials") return { verdict: "bad-credentials", detail: "Realm: invalid credentials" };
    if (e.kind === "attempt-limit") return { verdict: "attempt-limit", detail: `login attempt limit, wait ${e.lockoutSeconds}s` };
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

/** Re-check every suspended account (or just `guids`), a few at a time. */
export async function retrySuspended(deps: RetryDeps, guids?: string[], concurrency = 2): Promise<RetryResult[]> {
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
      const proxy = deps.proxies.configured ? deps.proxies.probeFor(acc.guid) : null;
      let r: { verdict: RetryVerdict; detail: string };
      try {
        const v = deps.verify ? await deps.verify(acc, proxy) : await verifyOnce(acc, proxy);
        r = typeof v === "string" ? { verdict: v, detail: "" } : v;
      } catch (e) {
        r = { verdict: "error", detail: String(e) };
      }
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
