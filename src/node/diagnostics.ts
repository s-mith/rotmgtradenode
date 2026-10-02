// The text an owner copies for whoever helps them (scratchpad contract
// "Windows-ready node", GET /api/dev/diagnostics): versions, the computer,
// settings, proxies, accounts, the status and the newest log lines, with
// everything private taken out: emails (and aliases that spell them out),
// passwords, proxy logins, tokens, codes, session ids and the computer's
// user folder. Built on the relay; the site adds what only it
// knows (open requests, communism) as extra sections.
import os from "node:os";
import type { Fleet } from "../relay/fleet/fleet";
import { onlineCapFor } from "../relay/fleet/constants";
import { buildStatus, statusFacts, type StatusFacts } from "./status";

export const DIAGNOSTICS_LOG_LINES = 300;

/** "abcdef@hotmail.com" -> "a***@hotmail.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
/** An exit address without what identifies it: "45.67.89.10" -> "45.67.x.x", "proxy.example.com" -> "p***.example.com"; a port is kept. */
export function maskHost(hostPort: string): string {
  const m = /^(.*?)(:\d{1,5})?$/.exec(hostPort.trim());
  const host = m?.[1] ?? hostPort;
  const port = m?.[2] ?? "";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) return `${v4[1]}.${v4[2]}.x.x${port}`;
  const labels = host.split(".");
  if (labels.length >= 2) return `${labels[0][0] ?? ""}***.${labels.slice(1).join(".")}${port}`;
  return `${host[0] ?? ""}***${port}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Take private things out of text: every literal in `secrets` (passwords,
 * proxy usernames and passwords; 3 characters or more, matched as a whole
 * word), credentials inside URLs and proxy lines, key=value secrets, long
 * tokens and ids, whispered codes, emails, and IPv4 addresses.
 */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  const words = [...new Set([...secrets].filter((s) => typeof s === "string" && s.length >= 3))].sort((a, b) => b.length - a.length);
  for (const w of words) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(w)}(?![A-Za-z0-9])`, "g"), "[hidden]");
  out = out
    // scheme://user:pass@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[hidden]@")
    // host:port:user:pass (a pasted proxy line)
    .replace(/\b((?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(\d{2,5}):[^\s:]+:\S+/g, "$1:$2:[hidden]")
    // password=..., token: ..., "secret":"..."
    .replace(/\b(password|passwd|pwd|secret|token|accesstoken|access_token|authorization|cookie|sessionid|session_id|sid|key|link ?code|login ?code)("?\s*[=:]\s*"?)[^\s",&}]+/gi, "$1$2[hidden]")
    // ?token=...&...
    .replace(/([?&][A-Za-z_]+=)[^&\s"]+/g, "$1[hidden]")
    // a whisper: /tell <name> <code>
    .replace(/(\/tell\s+\S+\s+)\S+/gi, "$1[hidden]")
    // JWTs, access tokens, long ids
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[token]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[id]")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_+=-]{40,}(?![A-Za-z0-9_-])/g, "[token]")
    .replace(EMAIL, (e) => maskEmail(e))
    // IPv4 addresses, not version numbers like Realm's build 7.0.0.2.0
    .replace(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}(?![\d]|\.\d)/g, "$1.$2.x.x")
    // The computer's user folder, often the owner's name (Windows names it after a Microsoft account's email).
    .replace(/\b([A-Za-z]:\\{1,2}Users\\{1,2})[^\\\s"]+/g, "$1[you]")
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, "$1[you]");
  return out;
}

/**
 * Names for accounts whose alias gives their login away. An account added
 * without a name is called by the part of its email before the @, so its
 * alias next to the masked email ("bob123 b***@hotmail.com") spells the email
 * out. Those become "account 1", "account 2", ... in roster order; an alias the
 * owner chose stays.
 */
export function accountLabels(accounts: readonly { alias: string; guid: string }[]): Map<string, string> {
  const labels = new Map<string, string>();
  accounts.forEach((a, i) => {
    const local = a.guid.includes("@") ? a.guid.slice(0, a.guid.lastIndexOf("@")) : a.guid;
    const alias = a.alias.trim().toLowerCase();
    if (alias === local.toLowerCase() || alias === a.guid.toLowerCase() || alias.includes("@")) labels.set(a.alias, `account ${i + 1}`);
  });
  return labels;
}

/** Each alias in `labels` replaced by its label wherever it shows as a whole word. */
export function relabel(text: string, labels: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [alias, label] of [...labels].sort((a, b) => b[0].length - a[0].length)) {
    if (alias.length < 3) continue; // too short to tell from ordinary words; the account lines use the label already
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(alias)}(?![A-Za-z0-9])`, "gi"), label);
  }
  return out;
}

const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const duration = (s: number) => `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
const stamp = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 19);
const onOff = (b: boolean) => (b ? "on" : "off");

export interface DiagnosticsSection {
  title: string;
  lines: string[];
}

/** Everything the fleet knows, as text with the private parts taken out. `site`: the site's facts for the status; `extra`: sections only the site can write. */
export function buildDiagnostics(fleet: Fleet, o: { site?: StatusFacts["site"]; extra?: DiagnosticsSection[]; now?: number } = {}): string {
  const now = o.now ?? Date.now();
  const s = fleet.nodeSettings.get();
  const facts = statusFacts(fleet, now);
  if (o.site) facts.site = o.site;
  const status = buildStatus(facts);
  const gate = fleet.buildGate.status();
  const hub = fleet.hub.status();
  const setup = facts.setup;
  const sections: DiagnosticsSection[] = [];

  sections.push({
    title: "App",
    lines: [
      `Made: ${stamp(now)} UTC`,
      `App version: ${fleet.nodeVersion}`,
      `Realm build: ${gate.build} (${gate.known ? "known to work" : "new to this node"}; logins ${gate.held ? "held" : "allowed"})`,
      `Computer: ${os.type()} ${os.release()} ${process.arch}, ${os.cpus().length} CPU(s), ${Math.round(os.freemem() / 2 ** 20)} of ${Math.round(os.totalmem() / 2 ** 20)} MB memory free`,
      `Node.js ${process.version}${process.versions.electron ? `, Electron ${process.versions.electron}` : ""}`,
      `Node running for ${duration(Math.floor((now - fleet.startedAt) / 1000))}; computer up for ${duration(Math.floor(os.uptime()))}`,
    ],
  });
  sections.push({
    title: "Status",
    lines: [`${status.state}: ${status.headline}${status.sub ? ` — ${status.sub}` : ""}`, ...status.problems.map((p) => `- [${p.severity}] ${p.text}`)],
  });
  const t = setup.steps.test.last;
  sections.push({
    title: "Setup and settings",
    lines: [
      `Setup: ${setup.complete ? `finished ${s.setup.completedAt ? stamp(s.setup.completedAt) : ""}` : "not finished"}; connection ${setup.steps.connection.mode}; rotmg trade ${hub.linked ? "linked" : s.setup.hubSkipped ? "skipped" : "not linked"}`,
      `Test login: ${t ? `${t.state} ${stamp(t.at)} (${t.message})` : "none this run"}`,
      `Proxy only: ${onOff(s.proxies.required)}; own internet allowed: ${s.proxies.required ? "no" : s.proxies.ownInternetAt ? `yes, since ${stamp(s.proxies.ownInternetAt)}` : "yes"}`,
      `Advanced management: standard ${onOff(s.advanced.pool)}, communism ${onOff(s.advanced.communism)}; login desk always on: ${onOff(s.loginDesk.alwaysOn)}; trades with players: ${onOff(s.players.enabled)}; telemetry: ${onOff(s.telemetry.enabled)}`,
      `rotmg trade: ${hub.linked ? `linked to ${hub.url}; last heartbeat ${hub.lastHeartbeatAt ? `${ago(now - hub.lastHeartbeatAt)} ago` : "never"}${hub.outdated ? "; wants a newer app" : ""}${hub.lastError ? `; last error: ${hub.lastError}` : ""}` : "not linked"}`,
      `Game version feed: ${fleet.versions.polling ? "following" : "pinned"}${fleet.versions.lastError ? `; last error: ${fleet.versions.lastError}` : ""}`,
    ],
  });
  const accounts = fleet.pool.every();
  const labels = accountLabels(accounts);
  const health = fleet.proxies.healthReport();
  const checks = fleet.setup.proxyChecks();
  sections.push({
    title: "Proxies",
    lines: [
      health.length
        ? `${health.length} listed, ${health.filter((h) => h.enabled).length} switched on, ${fleet.proxies.occupiedCount()} in use; bots online at once: ${onlineCapFor(fleet.proxies.exclusiveCapacity())}`
        : `None listed${s.proxies.required ? "" : " (bots use this computer's own internet, one at a time)"}`,
      ...health.map((h) => {
        const c = checks.get(h.host);
        const user = h.usedBy ? fleet.pool.byGuid(h.usedBy) : undefined;
        const usedBy = h.usedBy ? (user ? labels.get(user.alias) ?? user.alias : "a bot") : null;
        return `- ${maskHost(`${h.host.replace(/:\d+$/, "")}:${h.port}`)} ${h.enabled ? "on" : "off"}, ${h.ok} ok / ${h.fail} failed${h.banned ? ", blocked by Realm" : h.benched ? ", resting" : ""}${usedBy ? `, in use by ${usedBy}` : ""}${c ? `, last test ${c.ok ? "worked" : "failed"} ${ago(now - c.at)} ago` : ""}`;
      }),
    ],
  });
  const igns = fleet.tracker.ignsSnapshot();
  sections.push({
    title: "Accounts",
    lines: [
      `${accounts.length} on the roster; ${facts.accounts.ready} can log in; ${facts.accounts.inGame} in the game; ${facts.accounts.suspended.length} suspended`,
      ...accounts.map((a) => {
        const live = a.client?.active ? a.client : fleet.clients.get(a.guid);
        const state = a.suspended || fleet.gate.isRetired(a.guid) ? "suspended"
          : fleet.gate.hasBadCredentials(a.guid) ? "wrong email or password"
          : live && live.active ? `online on ${live.server}${live.objectId !== -1 ? ", in the game" : ", logging in"}`
          : fleet.gate.lockoutRemainingMs(a.guid) > 0 ? `waiting ${ago(fleet.gate.lockoutRemainingMs(a.guid))} before its next login` : "offline";
        const last = a.lastLoginError ? `; last login problem ${ago(now - a.lastLoginError.at)} ago: ${a.lastLoginError.kind} (${a.lastLoginError.message})` : "";
        return `- ${labels.get(a.alias) ?? a.alias}${igns[a.botGuid] ? ` (${igns[a.botGuid]})` : ""} ${maskEmail(a.guid)}: ${a.communism ? "communism, " : ""}${a.seasonal === null ? "season unknown" : a.seasonal ? "seasonal" : "non-seasonal"}, ${state}${a.assignedKind ? `, busy with a ${a.assignedKind}` : ""}${last}`;
      }),
    ],
  });
  for (const e of o.extra ?? []) sections.push(e);
  const tail = fleet.logTail(DIAGNOSTICS_LOG_LINES);
  sections.push({ title: `Log (last ${tail.length} lines)`, lines: tail.map((l) => `${stamp(l.at).slice(11)} ${l.line}`) });

  // Every account password and proxy login, taken out wherever it shows up.
  const secrets: string[] = [];
  for (const a of accounts) {
    if (a.info.password) secrets.push(a.info.password);
    if (a.info.secret) secrets.push(a.info.secret);
    if (a.info.proxy?.username) secrets.push(a.info.proxy.username);
    if (a.info.proxy?.password) secrets.push(a.info.proxy.password);
  }
  for (const e of fleet.proxies.entriesFor()) {
    if (e.proxy.username) secrets.push(e.proxy.username);
    if (e.proxy.password) secrets.push(e.proxy.password);
  }
  const text = [`rotmg trade node: diagnostics`, ...sections.flatMap((x) => ["", `== ${x.title} ==`, ...x.lines])].join("\n");
  // After the emails are masked, so a full email is never half relabelled.
  return relabel(redact(text, secrets), labels) + "\n";
}
