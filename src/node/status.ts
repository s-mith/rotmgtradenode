// The node's state in one line an owner who is not technical can read: what
// it is doing, and each thing that needs them, with a button that fixes it
// (scratchpad contract "Windows-ready node", GET /api/dev/status). The facts
// come from the fleet (statusFacts, served by the control plane's GET
// /status) and from the site (communism, a frozen node); buildStatus turns
// them into words. Nothing here says "proxy pool", "canary" or an error id.
import type { Fleet } from "../relay/fleet/fleet";
import { MAX_NODE_BOTS } from "../shared/hubWire";
import type { SetupView } from "./setup";

export type StatusFix =
  | { label: string; kind: "tab"; tab: string }
  | { label: string; kind: "post"; path: string; body: unknown }
  | { label: string; kind: "link"; href: string };
export interface StatusProblem {
  id: string;
  severity: "error" | "warning";
  text: string;
  fix?: StatusFix;
}
export interface NodeStatusView {
  ok: true;
  state: "running" | "ready" | "paused" | "needs-setup" | "problem";
  headline: string;
  sub: string | null;
  problems: StatusProblem[];
}

/** An account's last failed login, as the fleet recorded it. */
export interface AccountProblemFact {
  alias: string;
  ign: string;
  /** bad-credentials, suspended, attempt-limit, account-in-use, network, or anything else Realm said. */
  kind: string;
  message: string;
  at: number;
}
/** What the status is made of: plain data, so the site can add its part and tests can build any state. */
export interface StatusFacts {
  now: number;
  setup: SetupView;
  /** Logins held for the whole node (the build gate, Realm calling the build outdated), and why. */
  gate: { holdReason: string | null; ratePausedMs: number };
  tradeHold: { active: boolean; reason: string | null };
  proxies: { listed: number; enabled: number; failing: number; banned: number; checked: number; working: number };
  accounts: { total: number; ready: number; inGame: number; busy: number; suspended: string[]; problems: AccountProblemFact[] };
  hub: { linked: boolean; outdated: boolean; lastError: string | null; lastHeartbeatAt: number | null };
  /** What only the site knows; absent on a relay by itself. */
  site?: { communismError: string | null; frozen: boolean };
}

/** The fleet's half of the facts. */
export function statusFacts(fleet: Fleet, now = Date.now()): StatusFacts {
  const { gate } = fleet;
  const hub = fleet.hub.status();
  const health = fleet.proxies.healthReport();
  const checks = fleet.setup.proxyChecks();
  const accounts = fleet.pool.every();
  const igns = fleet.tracker.ignsSnapshot();
  const out = (a: (typeof accounts)[number]) => a.suspended || gate.isRetired(a.guid);
  // In the game: the dispatcher's bots and the ones a maintenance job has online.
  const inGame = new Set<string>();
  for (const [guid, c] of fleet.clients) if (c.active && c.objectId !== -1) inGame.add(guid);
  for (const a of accounts) if (a.client && a.client.active && a.client.objectId !== -1) inGame.add(a.guid);
  const problems: AccountProblemFact[] = [];
  for (const a of accounts) {
    if (out(a)) continue;
    const ign = igns[a.botGuid] ?? "";
    if (gate.hasBadCredentials(a.guid)) problems.push({ alias: a.alias, ign, kind: "bad-credentials", message: a.lastLoginError?.message ?? "", at: a.lastLoginError?.at ?? now });
    else if (a.lastLoginError && !inGame.has(a.guid)) problems.push({ alias: a.alias, ign, kind: a.lastLoginError.kind, message: a.lastLoginError.message, at: a.lastLoginError.at });
  }
  const listed = fleet.proxies.entriesFor();
  return {
    now,
    setup: fleet.setup.view(),
    gate: { holdReason: gate.holdReason, ratePausedMs: gate.ratePauseRemainingMs() },
    tradeHold: { active: fleet.hold.active, reason: fleet.hold.reason() },
    proxies: {
      listed: health.length,
      enabled: health.filter((h) => h.enabled).length,
      failing: health.filter((h) => h.enabled && !h.banned && (h.benched || h.fail >= 2)).length,
      banned: health.filter((h) => h.banned).length,
      checked: listed.filter((e) => checks.has(e.key)).length,
      working: listed.filter((e) => checks.get(e.key)?.ok).length,
    },
    accounts: {
      total: accounts.length,
      ready: accounts.filter((a) => !out(a) && !gate.hasBadCredentials(a.guid)).length,
      inGame: inGame.size,
      busy: accounts.filter((a) => a.assignedRequestId !== null).length,
      suspended: accounts.filter(out).map((a) => a.alias),
      problems,
    },
    hub: { linked: hub.linked, outdated: hub.outdated, lastError: hub.lastError, lastHeartbeatAt: hub.lastHeartbeatAt },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A time of day as this computer shows it (the node runs on the owner's own computer). */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ACCOUNTS: StatusFix = { label: "Open accounts", kind: "tab", tab: "accounts" };
const PROXIES: StatusFix = { label: "Open proxies", kind: "tab", tab: "proxies" };
const NODE: StatusFix = { label: "Open node settings", kind: "tab", tab: "node" };
const SETUP: StatusFix = { label: "Continue setup", kind: "link", href: "/setup" };
export const CHECK_BUILD: StatusFix = { label: "Check again", kind: "post", path: "/api/dev/node", body: { action: "check-build" } };

/** One account's failed login in words, and what to do about it. */
export function plainLoginProblem(kind: string, message: string): string {
  switch (kind) {
    case "bad-credentials": return "Realm says the email or password is wrong. Fix them on the Accounts page.";
    case "suspended": return "Realm banned this account (suspended). Remove it and add a different account.";
    case "attempt-limit": return "Realm is limiting logins for a few minutes. The node tries again by itself.";
    case "account-in-use": return "This account was logged in somewhere else, maybe in the game on this computer. Close it there; the node tries again by itself.";
    case "network": return /via direct/i.test(message)
      ? "Couldn't reach Realm. Check that this computer is online; if it is, Realm may be down for a while."
      : "Couldn't connect through the proxy. Test your proxies and replace the ones that fail.";
    default: {
      const said = message.replace(/^Realm answered:\s*/i, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      return said ? `Realm turned the last login away (“${said}”). The node tries again later.` : "The last login didn't work. The node tries again later.";
    }
  }
}

/** Why logins are held, in words. Both holds there are come from a Realm update. */
function plainHold(reason: string, linked: boolean): string {
  if (/outdated/i.test(reason)) return "Realm updated the game. The node is fetching the new version number and carries on by itself, usually within minutes.";
  return linked
    ? "Realm updated the game. Bots wait until rotmg trade confirms this node works with the new version, usually within an hour. Nothing is lost meanwhile."
    : "Realm updated the game. Bots wait until rotmg trade confirms this node works with the new version. Press Check again from time to time, or link the node to rotmg trade so it checks by itself.";
}

export function buildStatus(f: StatusFacts): NodeStatusView {
  const problems: StatusProblem[] = [];
  const add = (p: StatusProblem) => problems.push(p);
  // Accounts.
  for (const alias of f.accounts.suspended) add({ id: `suspended:${alias}`, severity: "error", text: `${alias}: Realm banned this account (suspended). Remove it and add a different account.`, fix: ACCOUNTS });
  for (const p of f.accounts.problems) {
    const fix = p.kind === "bad-credentials" ? { ...ACCOUNTS, label: "Fix it" } : p.kind === "network" && !/via direct/i.test(p.message) ? PROXIES : undefined;
    add({ id: `login:${p.alias}`, severity: p.kind === "bad-credentials" ? "error" : "warning", text: `${p.ign || p.alias}: ${plainLoginProblem(p.kind, p.message)}`, ...(fix ? { fix } : {}) });
  }
  if (f.accounts.total > MAX_NODE_BOTS) add({ id: "too-many-accounts", severity: "warning", text: `This node has ${f.accounts.total} accounts; rotmg trade keeps track of ${MAX_NODE_BOTS} per node. Remove ${f.accounts.total - MAX_NODE_BOTS}.`, fix: ACCOUNTS });
  // Proxies.
  const px = f.proxies;
  if (px.listed > 0 && px.enabled === 0) add({ id: "proxies-off", severity: "error", text: "Every proxy is switched off, so no bot can log in. Switch some back on.", fix: PROXIES });
  else if (px.listed > 0 && px.checked === px.listed && px.working === 0) add({ id: "proxies-dead", severity: "error", text: "None of your proxies worked in the last test. Replace them, then test again.", fix: PROXIES });
  else if (px.failing > 0) add({ id: "proxies-failing", severity: "warning", text: `${px.failing} of your ${plural(px.listed, "proxy", "proxies")} keep failing. Test them and replace the bad ones.`, fix: PROXIES });
  if (px.banned > 0) add({ id: "proxies-banned", severity: "warning", text: `Realm blocked ${plural(px.banned, "proxy", "proxies")}. The node rests ${px.banned === 1 ? "it" : "them"} for a few hours; replace ${px.banned === 1 ? "it" : "them"} if it keeps happening.`, fix: PROXIES });
  // rotmg trade.
  if (f.hub.linked && f.hub.outdated) add({ id: "hub-outdated", severity: "warning", text: "rotmg trade needs a newer version of this app. Update the app (restart it if an update is waiting)." });
  else if (f.hub.linked && f.hub.lastError && /unknown node/i.test(f.hub.lastError)) add({ id: "hub-unlinked", severity: "warning", text: "rotmg trade doesn't know this node any more (it was removed on the website). Unlink it, then link it again with a new code.", fix: NODE });
  else if (f.hub.linked && f.hub.lastError && (f.hub.lastHeartbeatAt === null || f.now - f.hub.lastHeartbeatAt > 5 * 60_000)) {
    add({ id: "hub-unreachable", severity: "warning", text: "Can't reach rotmg trade right now. Trades through the website wait until it is back.", fix: { label: "Try again", kind: "post", path: "/api/dev/node", body: { action: "hub-heartbeat" } } });
  }
  // The site.
  if (f.site?.frozen) add({ id: "hub-frozen", severity: "warning", text: "The rotmg trade team paused this node's offers. Ask them on Discord why." });
  if (f.site?.communismError) add({ id: "communism", severity: "warning", text: `Communism had a problem: ${f.site.communismError}`, fix: ACCOUNTS });

  const sorted = () => [...problems].sort((a, b) => Number(a.severity === "warning") - Number(b.severity === "warning"));
  const conn = f.setup.steps.connection;
  // Not set up: that comes first.
  if (!f.setup.complete || f.accounts.total === 0 || conn.mode === "none") {
    const first: StatusProblem = f.setup.complete
      ? f.accounts.total === 0
        ? { id: "setup-accounts", severity: "warning", text: "Add a game account for the node to use.", fix: { ...ACCOUNTS, label: "Add an account" } }
        : { id: "setup-connection", severity: "warning", text: "Choose how bots connect: add proxies, or allow your own internet.", fix: PROXIES }
      : { id: "setup", severity: "warning", text: "Setup isn't finished yet.", fix: SETUP };
    return { ok: true, state: "needs-setup", headline: "Finish setting up", sub: "Add an account and choose how bots connect; then the node is ready.", problems: [first, ...sorted()] };
  }
  // Paused: logins held for the whole node.
  if (f.gate.holdReason) {
    const sub = plainHold(f.gate.holdReason, f.hub.linked);
    return { ok: true, state: "paused", headline: "Paused: Realm updated the game", sub, problems: [{ id: "paused", severity: "warning", text: sub, fix: CHECK_BUILD }, ...sorted()] };
  }
  if (f.gate.ratePausedMs > 0) {
    const sub = `Realm asked the node to slow down. Logins start again at ${clock(f.now + f.gate.ratePausedMs)}.`;
    return { ok: true, state: "paused", headline: "Paused: Realm asked us to slow down", sub, problems: [{ id: "paused", severity: "warning", text: sub }, ...sorted()] };
  }
  if (f.tradeHold.active) {
    const sub = `Trades wait while the node does upkeep${f.tradeHold.reason ? ` (${f.tradeHold.reason})` : ""}. They carry on by themselves.`;
    return { ok: true, state: "paused", headline: "Paused for upkeep", sub, problems: [{ id: "paused", severity: "warning", text: sub }, ...sorted()] };
  }
  if (f.accounts.ready === 0) return { ok: true, state: "problem", headline: "No account can log in", sub: "Fix or replace the accounts below.", problems: sorted() };
  if (problems.some((p) => p.severity === "error") && f.accounts.inGame === 0) {
    return { ok: true, state: "problem", headline: "Something needs your attention", sub: "Fix what is below so the bots can work.", problems: sorted() };
  }
  if (f.accounts.inGame > 0) {
    return { ok: true, state: "running", headline: `Running: ${plural(f.accounts.inGame, "bot")} in the game`, sub: f.accounts.busy ? `${plural(f.accounts.busy, "trade")} going on now.` : "Bots log out by themselves when there is nothing to do.", problems: sorted() };
  }
  return { ok: true, state: "ready", headline: "Ready", sub: `${plural(f.accounts.ready, "account")} ready. Bots log in by themselves when someone trades with this node.`, problems: sorted() };
}
