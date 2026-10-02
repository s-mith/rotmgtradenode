import { json } from "@/server/http";
import { checkDevPassword, communism, hubRequests, pyrelay, swaps } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { MAX_NODE_BOTS } from "@/shared/hubWire";

// GET /api/dev/overview — the one line the control panel keeps in view, and
// the landing tab: is the node safe to log in, is it linked, do accounts have
// a way in, what is happening right now, what needs a hand. Everything here
// is drawn from the other tabs' sources; nothing is computed only for it.
export type Overview = {
  ok: true;
  gate: { build: string; known: boolean; held: boolean; reason: string | null };
  /** `frozen`: the hub operator froze this node (no new offers or accepts), as of the hub's last reply about offers. */
  hub: { linked: boolean; url: string | null; lastHeartbeatAt: number | null; lastError: string | null; outdated: boolean; frozen: boolean };
  proxies: { listed: number | null; enabled: number; inUse: number; required: boolean };
  servers: { known: number; fetchedAt: number | null; stale: boolean; lastError: string | null };
  accounts: { total: number; online: number; suspended: number; attention: { alias: string; ign: string; message: string; at: number }[]; communism: number };
  requests: { deposits: number; withdraws: number; claimed: number };
  meetings: { open: number };
  communism: { accounts: number; items: number; free: { seasonal: number; nonseasonal: number }; hubRequests: number; lastError: string | null };
  attention: { text: string; tab: string }[];
};

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const [node, prox, accs] = await Promise.all([pyrelay.nodeStatus(), pyrelay.proxies(), pyrelay.accountLookup("", 10_000)]);
  if (!node.ok) return json({ error: node.error }, { status: node.status });
  const db = getDb();
  const open = (table: string) => db.prepare(`SELECT COUNT(*) AS n, SUM(status = 'claimed') AS c FROM ${table} WHERE status IN ('pending','claimed')`).get() as { n: number; c: number | null };
  const dep = open("deposit_requests");
  const wd = open("withdraw_requests");
  const accounts = accs.ok ? (accs.data as { accounts: { alias: string; ign: string; online: boolean; suspended: boolean; communism?: boolean; lastLoginError: { at: number; kind: string; message: string } | null }[] }).accounts : [];
  const attentionAccounts = accounts.filter((a) => a.lastLoginError && !a.online && !a.suspended).map((a) => ({ alias: a.alias, ign: a.ign, message: a.lastLoginError!.message, at: a.lastLoginError!.at }));
  const sw = swaps()?.status();
  const meetings = sw ? sw.rendezvous.filter((r) => r.state === "meet" || r.localState === "meet").length : 0;
  const frozen = !!sw?.limits?.frozen;
  const c = communism();
  const cs = c?.status();
  const proxies = prox.ok ? { listed: prox.data.capacity === null ? null : prox.data.proxies.length, enabled: prox.data.proxies.filter((p) => p.enabled).length, inUse: prox.data.inUse, required: prox.data.required } : { listed: null, enabled: 0, inUse: 0, required: true };
  const attention: Overview["attention"] = [];
  if (node.data.build.held) attention.push({ text: `Logins are held: ${node.data.build.reason ?? "the Realm build is not known to work"}. Run a canary login.`, tab: "overview" });
  if (proxies.required && proxies.enabled === 0) attention.push({ text: "No proxies listed and \"proxy only\" is on: nothing can log in.", tab: "proxies" });
  for (const a of attentionAccounts) attention.push({ text: `${a.ign || a.alias}: last login failed (${a.message}).`, tab: "accounts" });
  const suspended = accounts.filter((a) => a.suspended).length;
  if (suspended) attention.push({ text: `${suspended} account${suspended === 1 ? " is" : "s are"} suspended.`, tab: "accounts" });
  if (frozen) attention.push({ text: "The hub operator has frozen this node: it can post and accept no offers until they unfreeze it.", tab: "overview" });
  if (node.data.hub.linked && node.data.hub.outdated) attention.push({ text: "The hub wants a newer node version.", tab: "overview" });
  if (cs?.lastError) attention.push({ text: `Communism: ${cs.lastError}`, tab: "accounts" });
  if (accounts.length > MAX_NODE_BOTS) attention.push({ text: `${accounts.length} accounts: the hub keeps track of ${MAX_NODE_BOTS} per node, so with more it no longer sees this node's accounts properly. Remove ${accounts.length - MAX_NODE_BOTS}.`, tab: "accounts" });
  const out: Overview = {
    ok: true,
    gate: { build: node.data.build.build, known: node.data.build.known, held: node.data.build.held, reason: node.data.build.reason },
    hub: { linked: node.data.hub.linked, url: node.data.hub.url, lastHeartbeatAt: node.data.hub.lastHeartbeatAt, lastError: node.data.hub.lastError, outdated: node.data.hub.outdated, frozen },
    proxies,
    servers: { known: Object.keys(node.data.servers?.servers ?? {}).length, fetchedAt: node.data.servers?.fetchedAt ?? null, stale: !!node.data.servers?.stale, lastError: node.data.servers?.lastError ?? null },
    accounts: { total: accounts.length, online: accounts.filter((a) => a.online).length, suspended, attention: attentionAccounts, communism: accounts.filter((a) => a.communism).length },
    requests: { deposits: dep.n, withdraws: wd.n, claimed: (dep.c ?? 0) + (wd.c ?? 0) },
    meetings: { open: meetings },
    communism: { accounts: cs?.accounts.length ?? 0, items: cs?.items.length ?? 0, free: { seasonal: cs?.room.seasonal.free ?? 0, nonseasonal: cs?.room.nonseasonal.free ?? 0 }, hubRequests: hubRequests()?.status().recent.length ?? 0, lastError: cs?.lastError ?? null },
    attention,
  };
  return json(out, { headers: { "Cache-Control": "no-store" } });
}
