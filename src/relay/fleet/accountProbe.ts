// What Realm says about an account before the node takes it on: whether
// the credentials work, whether it is suspended, which characters it has,
// whether the tutorial is done, and the season and backpack of the
// character that would log in. HTTP only (a token and char/list), through
// a probe proxy when logins must go through one. The Accounts tab's add
// form relies on this instead of asking the owner for what Realm knows.
import { clientTokenFor, getAccessToken, getCharList, type CharDetail, type CharList } from "../realm/api";
import type { Proxy } from "../net/proxy";
import { pickCharId } from "../client/gameClient";

export type ProbeVerdict = "ok" | "suspended" | "bad-credentials" | "attempt-limit" | "error";
export interface ProbeResult {
  verdict: ProbeVerdict;
  detail: string;
  /** With verdict "ok": the account as Realm lists it. */
  chars: CharDetail[];
  tutorialDone: boolean;
  /** The character that would log in (the preferred one when it exists, else the first), or null with no character. */
  loaded: CharDetail | null;
}

export async function probeAccount(creds: { guid: string; password?: string; secret?: string }, proxy: Proxy | null, preferredCharId: number | null = null): Promise<ProbeResult> {
  const none = { chars: [] as CharDetail[], tutorialDone: false, loaded: null };
  const tok = await getAccessToken({ guid: creds.guid, password: creds.password ?? "", secret: creds.secret }, clientTokenFor(creds.guid, creds.password ?? ""), proxy);
  if (!tok.ok) {
    const e = tok.error;
    if (e.kind === "suspended") return { verdict: "suspended", detail: "Realm: the account is suspended", ...none };
    if (e.kind === "bad-credentials") return { verdict: "bad-credentials", detail: "Realm: invalid credentials", ...none };
    if (e.kind === "attempt-limit") return { verdict: "attempt-limit", detail: `login attempt limit, wait ${e.lockoutSeconds}s`, ...none };
    return { verdict: "error", detail: e.kind === "network" ? `network: ${e.detail}` : `verify failed: ${e.kind}`, ...none };
  }
  const cl = await getCharList(tok.value, proxy);
  if (!cl.ok) {
    const e = cl.error;
    if (e.kind === "suspended") return { verdict: "suspended", detail: "Realm: the account is suspended", ...none };
    return { verdict: "error", detail: e.kind === "network" ? `network: ${e.detail}` : `char/list failed: ${e.kind}`, ...none };
  }
  return { verdict: "ok", detail: describe(cl.value), ...fromCharList(cl.value, preferredCharId) };
}

/** The probe's view of a char/list result (also what the game client uses at login). */
export function fromCharList(cl: CharList, preferredCharId: number | null): { chars: CharDetail[]; tutorialDone: boolean; loaded: CharDetail | null } {
  const loaded = cl.charIds.length ? cl.chars.find((c) => c.id === pickCharId(preferredCharId, cl.charIds)) ?? null : null;
  return { chars: cl.chars, tutorialDone: cl.tutorialDone, loaded };
}
function describe(cl: CharList): string {
  return `${cl.charIds.length} character(s), tutorial ${cl.tutorialDone ? "done" : "not done"}`;
}
