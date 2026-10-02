// Proxy descriptors, the lines an owner pastes (in every shape proxy sellers
// hand them out), and a check of one proxy: can it be reached, does it take
// the login, and will it connect to Realm's website and a game server.
import { SocksClient } from "socks";

export interface Proxy {
  host: string;
  port: number;
  /** 4 or 5. HTTP proxies aren't supported on the game socket. */
  type: 4 | 5;
  username: string;
  password: string;
}

/** One pasted line, read: a proxy, a line to skip (blank, a comment), or why it could not be read, in plain words. */
export type ProxyLineResult = { kind: "proxy"; proxy: Proxy; note?: string } | { kind: "skip" } | { kind: "error"; error: string };

/** One line of a pasted list as the console shows it: never the credentials. */
export type ProxyLineReport =
  | { line: number; ok: true; display: string; type: "socks5" | "socks4"; note?: string }
  | { line: number; ok: false; raw: string; error: string; skipped?: true };

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const isPort = (s: string): boolean => /^\d{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
const isHost = (s: string): boolean => s.length > 0 && s.length <= 253 && s.split(".").every((l) => LABEL.test(l));
const SOCKS4 = new Set(["socks4", "socks4a"]);
const SOCKS5 = new Set(["socks5", "socks5h", "socks"]);
const HTTP = new Set(["http", "https"]);
const KNOWN_SCHEMES = new Set([...SOCKS4, ...SOCKS5, ...HTTP]);
const SHAPES = "Use host:port, host:port:username:password or username:password@host:port.";

/**
 * Read one pasted line. Accepts host:port, host:port:user:pass,
 * user:pass@host:port, host:port@user:pass, user:pass:host:port, the same
 * with spaces, tabs, commas or semicolons between the parts, and an optional
 * socks5:// (socks5h, socks4, socks4a, socks) prefix. Blank lines and lines
 * starting with #, // or ; are skipped, and so is a trailing " # comment".
 * An http(s):// line is kept and spoken to as SOCKS5, as before: providers
 * such as Webshare answer both on the same port, and the check says whether
 * this one does.
 */
export function readProxyLine(raw: string): ProxyLineResult {
  let line = raw.trim();
  if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) return { kind: "skip" };
  line = line.replace(/\s+#.*$/, "").trim();
  let scheme: string | null = null;
  const url = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(line);
  if (url) {
    scheme = url[1].toLowerCase();
    line = line.slice(url[0].length).replace(/\/+$/, "");
  }
  type Parts = { host: string; port: string; username: string; password: string };
  // user:pass@host:port or host:port@user:pass; null when the line is not that shape.
  const atForm = (): Parts | null => {
    if (!line.includes("@")) return null;
    const at = line.lastIndexOf("@");
    const left = line.slice(0, at).split(":");
    const right = line.slice(at + 1).split(":");
    if (right.length === 2 && isPort(right[1])) return { host: right[0], port: right[1], username: left[0] ?? "", password: left.slice(1).join(":") };
    if (left.length === 2 && isPort(left[1])) return { host: left[0], port: left[1], username: right[0] ?? "", password: right.slice(1).join(":") };
    return null;
  };
  // host:port[:user:pass] or user:pass:host:port, with colons or spaces/tabs/commas/semicolons between the parts.
  let colonError: string | null = null;
  const colonForm = (): Parts | null => {
    let parts = line.split(":").map((p) => p.trim());
    if (parts.length === 1) parts = line.split(/[\s,;]+/).filter(Boolean);
    // An old "socks5:host:port[:user:pass]" line, the scheme without its slashes.
    if (scheme === null && (parts.length === 3 || parts.length === 5) && KNOWN_SCHEMES.has(parts[0].toLowerCase())) {
      scheme = parts[0].toLowerCase();
      parts = parts.slice(1);
    }
    if (parts.length === 2) return { host: parts[0], port: parts[1], username: "", password: "" };
    if (parts.length === 3) {
      // host:port:user — a password missing. Anything else of three parts is no proxy line at all.
      if (isPort(parts[1])) colonError = "This line has a username but no password. Use host:port:username:password.";
      return null;
    }
    if (parts.length >= 4 && isPort(parts[1])) return { host: parts[0], port: parts[1], username: parts[2], password: parts.slice(3).join(":") };
    if (parts.length === 4 && isPort(parts[3])) return { host: parts[2], port: parts[3], username: parts[0], password: parts[1] };
    return null;
  };
  const read = atForm() ?? colonForm();
  if (!read) return { kind: "error", error: colonError ?? `Couldn't read this line. ${SHAPES}` };
  let { host, port } = read;
  const { username, password } = read;
  host = host.trim();
  if (!isPort(port.trim())) return { kind: "error", error: "The port must be a number from 1 to 65535." };
  if (!isHost(host)) return { kind: "error", error: `“${host}” doesn't look like a proxy address. ${SHAPES}` };
  if (scheme !== null && !KNOWN_SCHEMES.has(scheme)) return { kind: "error", error: `The node can't use “${scheme}” proxies. Ask your provider for SOCKS5 proxies.` };
  if ((username === "") !== (password === "")) return { kind: "error", error: "This line has a username but no password. Use host:port:username:password." };
  const type: 4 | 5 = scheme !== null && SOCKS4.has(scheme) ? 4 : 5;
  const proxy: Proxy = { host, port: Number(port), type, username, password };
  return scheme !== null && HTTP.has(scheme)
    ? { kind: "proxy", proxy, note: "Listed as an HTTP proxy: the node speaks SOCKS5 to it. Many providers answer both on the same port; “Test” tells you whether this one does." }
    : { kind: "proxy", proxy };
}

/** A pasted line with whatever could be a username or password hidden: kept are only the parts that look like an address or a port. */
export function maskProxyLine(raw: string): string {
  const s = raw.trim();
  const url = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)/.exec(s);
  const prefix = url ? url[1] : "";
  const body = s.slice(prefix.length);
  const mask = (part: string) => (isPort(part) || /^\d{1,3}(\.\d{1,3}){3}$/.test(part) || (isHost(part) && part.includes(".")) ? part : "••••");
  const masked = body.split("@").map((side) => side.split(/([:\s,;]+)/).map((p, i) => (i % 2 === 1 ? p : mask(p))).join("")).join("@");
  return prefix + masked;
}

/**
 * A whole pasted list: one report per line that is not blank or a comment,
 * and the proxies to use, the same proxy listed twice kept once.
 */
export function parseProxyText(text: string): { lines: ProxyLineReport[]; proxies: Proxy[] } {
  const lines: ProxyLineReport[] = [];
  const proxies: Proxy[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const r = readProxyLine(raw);
    if (r.kind === "skip") return;
    if (r.kind === "error") {
      lines.push({ line, ok: false, raw: maskProxyLine(raw), error: r.error });
      return;
    }
    const p = r.proxy;
    const key = `${p.host.toLowerCase()}:${p.port}:${p.username}`;
    const first = seen.get(key);
    if (first !== undefined) {
      lines.push({ line, ok: false, raw: maskProxyLine(raw), error: `Same proxy as line ${first}, so it is skipped.`, skipped: true });
      return;
    }
    seen.set(key, line);
    proxies.push(p);
    lines.push({ line, ok: true, display: `${p.host}:${p.port}`, type: p.type === 4 ? "socks4" : "socks5", ...(r.note ? { note: r.note } : {}) });
  });
  return { lines, proxies };
}

/** Parse one proxies.txt line. Returns null for blanks, comments and junk. */
export function parseProxyLine(raw: string): Proxy | null {
  const r = readProxyLine(raw);
  return r.kind === "proxy" ? r.proxy : null;
}

export function parseProxyList(body: string): Proxy[] {
  return parseProxyText(body).proxies;
}

/** socks5h:// URL for the HTTP agent (remote DNS, like PySocks' rdns=True). */
export function proxyUrl(p: Proxy): string {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : "";
  return `socks${p.type}h://${auth}${p.host}:${p.port}`;
}

// --- checking a proxy ------------------------------------------------------------

/** What a check of one proxy found, for the owner: `host` is host:port, never the credentials. */
export interface ProxyCheck {
  host: string;
  ok: boolean;
  /** How long the two connections through it took, when they were made. */
  ms?: number;
  error?: string;
}
export interface ProxyCheckTargets {
  /** Realm's website (account checks, character lists). */
  web: { host: string; port: number };
  /** One game server (the bots' sessions). */
  game: { host: string; port: number };
  /** Per proxy, both connections together. */
  timeoutMs: number;
  /** Slower than this is not good enough for the game. */
  slowMs: number;
}

/** What went wrong, in words an owner can act on. `stage`: which connection it was. */
export function plainProxyError(e: unknown, stage: "web" | "game"): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code ?? "";
  if (/Authentication failed/i.test(msg)) return "Wrong proxy username or password.";
  if (/no accepted authentication type|unknown authentication type/i.test(msg)) return "The proxy wants a username and password (or doesn't accept the ones given).";
  if (/rejected connection/i.test(msg)) {
    return stage === "web" ? "The proxy works, but it won't connect to Realm's website." : "The proxy blocks the game: it won't connect to Realm's game servers.";
  }
  if (/timed out/i.test(msg) || code === "ETIMEDOUT") return "Could not reach the proxy: it didn't answer in time.";
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(`${msg} ${code}`)) {
    return "Could not reach the proxy. Check the address and port, and that it is switched on with your provider.";
  }
  if (/invalid Socks|Socket closed|Negotiation error/i.test(msg)) return "The proxy didn't answer like a SOCKS5 proxy. It may be HTTP-only; ask your provider for SOCKS5.";
  return "The proxy didn't work.";
}

/** Through `p`, a connection to Realm's website, then one to a game server; closed again at once. */
export async function checkProxy(p: Proxy, t: ProxyCheckTargets): Promise<ProxyCheck> {
  const host = `${p.host}:${p.port}`;
  const started = Date.now();
  const deadline = started + t.timeoutMs;
  for (const stage of ["web", "game"] as const) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { host, ok: false, error: "Could not reach the proxy: it didn't answer in time." };
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: { host: p.host, port: p.port, type: p.type, userId: p.username || undefined, password: p.password || undefined },
        command: "connect",
        destination: t[stage],
        timeout: remaining,
      });
      socket.destroy();
    } catch (e) {
      return { host, ok: false, error: plainProxyError(e, stage) };
    }
  }
  const ms = Date.now() - started;
  if (ms > t.slowMs) return { host, ok: false, ms, error: `Too slow: it took ${(ms / 1000).toFixed(1)} s to answer. Bots would keep timing out through it.` };
  return { host, ok: true, ms };
}

/** Several proxies, `concurrency` at a time, in the order given. */
export async function checkProxies(list: Proxy[], t: ProxyCheckTargets, concurrency = 4): Promise<ProxyCheck[]> {
  const out: ProxyCheck[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await checkProxy(list[i], t);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return out;
}
