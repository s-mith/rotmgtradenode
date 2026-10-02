// The control-plane calls the setup wizard, the status card and the help
// page make (the shapes are the node's: scratchpad contract "Windows-ready
// node"). Every call answers in plain words: a failure becomes a sentence a
// person can act on, never a stack or an HTTP code alone.
import { devHeaders } from "@/components/devHeaders";

export type TestLogin = { state: "running" | "ok" | "failed"; account: string; ign?: string; server?: string; message: string; at: number };
export type SetupState = {
  complete: boolean;
  steps: {
    accounts: { done: boolean; count: number; ready: number };
    connection: { done: boolean; mode: "proxies" | "own" | "none"; proxies: number; working: number | null };
    hub: { done: boolean; linked: boolean; skipped: boolean };
    test: { done: boolean; last: TestLogin | null };
  };
};
export type Fix = { label: string; kind: "tab"; tab: string } | { label: string; kind: "post"; path: string; body: unknown } | { label: string; kind: "link"; href: string };
export type Problem = { id: string; severity: "error" | "warning"; text: string; fix?: Fix };
export type NodeStatus = { state: "running" | "ready" | "paused" | "needs-setup" | "problem"; headline: string; sub: string | null; problems: Problem[] };
export type ParsedLine = { line: number; ok: true; display: string; type: string } | { line: number; ok: false; raw: string; error: string };
export type ProxyTest = { host: string; ok: boolean; ms?: number; error?: string };
export type AccountRow = { alias: string; guid: string; ign: string; online: boolean; inWorld: boolean; suspended: boolean; communism: boolean; lastLoginError: { at: number; kind: string; message: string } | null };

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** A call to the node: JSON in and out, the owner's password when one is set. */
export async function call<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<Result<T>> {
  try {
    const r = await fetch(path, {
      method: init.method ?? "GET",
      headers: devHeaders(init.body !== undefined),
      cache: "no-store",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // not JSON
    }
    if (!r.ok) {
      const said = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
      return { ok: false, status: r.status, error: said || (r.status === 404 ? "This part of the node is not there yet: update the node and try again." : `The node answered with an error (${r.status}).`) };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the node. Is it still running?" };
  }
}

export const getSetup = () => call<SetupState & { ok: true }>("/api/dev/setup");
export const postSetup = (body: { action: "complete" | "skip-hub" | "reset" | "test-login"; guid?: string }) => call<SetupState & { ok: true; started?: boolean }>("/api/dev/setup", { method: "POST", body });
export const getStatus = () => call<NodeStatus & { ok: true }>("/api/dev/status");
export const getDiagnostics = () => call<{ ok: true; text: string }>("/api/dev/diagnostics");
export const parseProxies = (text: string) => call<{ ok: true; lines: ParsedLine[] }>("/api/dev/proxies", { method: "POST", body: { action: "parse", text } });
export const testProxies = (hosts?: string[]) => call<{ ok: true; results: ProxyTest[] }>("/api/dev/proxies", { method: "POST", body: { action: "test", ...(hosts ? { hosts } : {}) } });
export const saveProxies = (text: string) => call<{ text: string; proxies: unknown[]; required: boolean; saved?: { count: number; error: string | null } }>("/api/dev/proxies", { method: "POST", body: { text } });
export const getProxies = () => call<{ text: string; proxies: { host: string; enabled: boolean }[]; required: boolean }>("/api/dev/proxies");
export const ownInternet = (allow: boolean, acknowledged = false) => call<unknown>("/api/dev/proxies", { method: "POST", body: { action: "own-internet", allow, ...(acknowledged ? { acknowledged: true } : {}) } });
export const listAccounts = () => call<{ accounts: AccountRow[]; total: number }>("/api/dev/account-lookup?q=&limit=500");
export const addAccount = (email: string, password: string) => call<{ ok: true; where: string; detected: { tutorialDone: boolean; chars: number } | null }>("/api/dev/accounts", { method: "POST", body: { email, password } });
export const nodeInfo = () => call<{ hub: { linked: boolean; url: string | null; lastError: string | null } }>("/api/dev/node");
export const linkHub = (url: string, code: string) => call<unknown>("/api/dev/node", { method: "POST", body: { action: "hub-link", url, code, name: "my node" } });

/** What Realm or the node said about an account (relay/controlPlane.ts POST /accounts), as advice a person can follow. */
export function accountAdvice(error: string): string {
  const e = error.toLowerCase();
  if (/already on the roster|already added/.test(e)) return "That account is already added.";
  // Already plain, with the Steam/Google hint: keep it.
  if (/does not accept that email and password/.test(e)) return error;
  if (/credential|wrong password|not valid/.test(e)) return "Realm says the email or password is wrong. Check them (the password is case-sensitive) and try again.";
  if (/suspend/.test(e)) return "Realm says this account is suspended, so it cannot be used. Add a different account.";
  if (/attempt limit/.test(e)) return "Realm is blocking logins for a while because of too many attempts. Wait 5 minutes, then try again.";
  if (/tutorial|never played|no character/.test(e)) return "This account has not finished the tutorial yet. Log in to the game with it, play the tutorial to the end, then add it again.";
  if (/email looks wrong|email does not look right/.test(e)) return "That email does not look right. Use the email you log in to Realm with.";
  if (/could not reach realm/.test(e)) return "Could not reach Realm to check the account. Check your internet (or your proxies), then try again.";
  if (/no proxies listed|proxy only/.test(e)) return "Set up how your bots connect first: proxies, or your own internet.";
  return error;
}
