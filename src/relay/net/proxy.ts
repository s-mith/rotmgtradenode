// Proxy descriptors and the proxies.txt line format pyrelay accepted.
export interface Proxy {
  host: string;
  port: number;
  /** 4 or 5. HTTP proxies aren't supported on the game socket. */
  type: 4 | 5;
  username: string;
  password: string;
}

/** Parse one proxies.txt line. Returns null for blanks, comments and junk. */
export function parseProxyLine(raw: string): Proxy | null {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  let scheme: string | null = null;
  for (const s of ["socks5://", "socks4://", "http://", "https://"]) {
    if (line.toLowerCase().startsWith(s)) {
      scheme = s.replace("://", "");
      line = line.slice(s.length);
      break;
    }
  }
  let parts = line.split(":");
  if (scheme === null && (parts.length === 3 || parts.length === 5) &&
      ["socks5", "socks4", "http", "https"].includes(parts[0].toLowerCase())) {
    scheme = parts[0].toLowerCase();
    parts = parts.slice(1);
  }
  const type: 4 | 5 = scheme === "socks4" ? 4 : 5;
  if (parts.length === 2) {
    return { host: parts[0], port: Number(parts[1]), type, username: "", password: "" };
  }
  if (parts.length === 4) {
    return { host: parts[0], port: Number(parts[1]), type, username: parts[2], password: parts[3] };
  }
  return null;
}

export function parseProxyList(body: string): Proxy[] {
  const out: Proxy[] = [];
  for (const line of body.split(/\r?\n/)) {
    const p = parseProxyLine(line);
    if (p && Number.isInteger(p.port) && p.port > 0) out.push(p);
  }
  return out;
}

/** socks5h:// URL for the HTTP agent (remote DNS, like PySocks' rdns=True). */
export function proxyUrl(p: Proxy): string {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : "";
  return `socks${p.type}h://${auth}${p.host}:${p.port}`;
}
