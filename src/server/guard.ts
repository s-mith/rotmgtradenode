// Who may talk to /api at all. The control panel trusts every request in
// local mode (lib/devauth.ts), so two things a browser can be tricked into
// are refused here, before any handler runs:
//
//   - a page on another site posting to this node (CSRF): a state-changing
//     request whose Origin is not this server's own, or that the browser
//     marks cross-site, is refused. Callers that send no Origin at all
//     (curl, scripts, the desktop shell's own fetch) are not browsers acting
//     for another site and pass.
//   - a page that rebinds its own hostname to 127.0.0.1 (DNS rebinding): it
//     is same-origin with itself, so the Host header is the tell. On a
//     loopback bind only loopback names are served, plus ALLOWED_HOSTS.
//
// Control panel writes must also be JSON: a form or a no-cors fetch can only
// send text/plain or form encodings without a preflight.
import { isLoopbackHost } from "@/node/config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type GuardOptions = {
  /** The address the server is bound to (HOST). */
  bindHost: string;
  /** Extra host names this node is reached by (ALLOWED_HOSTS, comma separated). */
  allowedHosts?: string;
};

function hostName(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  const i = h.lastIndexOf(":");
  return i > 0 && h.indexOf(":") === i ? h.slice(0, i) : h;
}

function hostAllowed(host: string, opts: GuardOptions): boolean {
  const extra = (opts.allowedHosts ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const name = hostName(host);
  if (extra.includes(name)) return true;
  if (isLoopbackHost(name)) return true;
  if (!isLoopbackHost(opts.bindHost)) {
    // Reachable from the network (DEV_PASSWORD is required then, node/config.ts): the
    // names it is reached by are not knowable here unless the owner lists them.
    if (!extra.length) return true;
    return name === opts.bindHost.toLowerCase();
  }
  return false;
}

/** Why this request is refused, or null to let it through. */
export function guardRequest(req: Request, opts: GuardOptions): { status: number; error: string } | null {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  if (!hostAllowed(host, opts)) return { status: 421, error: "This node does not answer to that host name." };

  const isDev = url.pathname.startsWith("/api/dev/");
  const fetchSite = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  // Nothing in the control panel is for another site, not even a read.
  if (isDev && fetchSite === "cross-site") return { status: 403, error: "Cross-site request refused." };

  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;

  if (fetchSite === "cross-site") return { status: 403, error: "Cross-site request refused." };
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = origin === "null" ? null : new URL(origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    if (originHost === null || originHost !== host.trim().toLowerCase()) return { status: 403, error: "Cross-site request refused." };
  }
  if (isDev && !/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return { status: 415, error: "Control panel requests must be JSON (Content-Type: application/json)." };
  }
  return null;
}
