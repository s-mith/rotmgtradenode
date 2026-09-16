import { json } from "@/server/http";
import { promises as dns } from "node:dns";
import { checkDevPassword } from "@/lib/devauth";


// GET /api/dev/pyrelay-probe
// Aggressive diagnostic for "pyrelay unreachable" failures. Tries DNS
// lookup separately from the HTTP fetch, and tries a few candidate
// ports/protocols so we can tell apart DNS, TCP-refused, and bind-wrong
// failure modes without needing to shell into the container.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const base = process.env.PYRELAY_URL;
  const sharedAuth = process.env.PYRELAY_AUTH ?? "";

  // 1. DNS lookup against the host pulled from PYRELAY_URL. Tries A and AAAA.
  let host = "";
  try {
    if (base) host = new URL(base).hostname;
  } catch {
    host = "";
  }
  type DnsResult = {
    family: 4 | 6;
    addresses: string[] | null;
    error: string | null;
  };
  const dnsResults: DnsResult[] = [];
  if (host) {
    for (const family of [4, 6] as const) {
      try {
        const res = await dns.lookup(host, { family, all: true });
        dnsResults.push({
          family,
          addresses: res.map((r) => r.address),
          error: null,
        });
      } catch (e) {
        dnsResults.push({
          family,
          addresses: null,
          error: (e as Error).message,
        });
      }
    }
  }

  // 2. HTTP attempts: configured URL, plus a few likely variants if we
  //    suspect the port is wrong. Each attempt uses a 4s timeout so the
  //    whole probe finishes in under 20s.
  type Attempt = {
    label: string;
    url: string;
    ok: boolean;
    status: number | null;
    elapsedMs: number;
    bodyExcerpt: string | null;
    errorName: string | null;
    errorMessage: string | null;
    causeMessage: string | null;
  };
  const attempts: Attempt[] = [];
  const urls: { label: string; url: string }[] = [];
  if (base) urls.push({ label: "PYRELAY_URL", url: `${base.replace(/\/$/, "")}/pool` });
  if (host) {
    // Try alternate ports in case Railway PORT differs from 8080.
    urls.push({ label: "host:3000/pool", url: `http://${host}:3000/pool` });
    urls.push({ label: "host:80/pool", url: `http://${host}:80/pool` });
    urls.push({ label: "host:8080/healthz", url: `http://${host}:8080/healthz` });
  }
  for (const { label, url } of urls) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: sharedAuth ? { "X-Pyrelay-Auth": sharedAuth } : {},
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      const text = await res.text();
      attempts.push({
        label,
        url,
        ok: res.ok,
        status: res.status,
        elapsedMs: Date.now() - started,
        bodyExcerpt: text.slice(0, 200),
        errorName: null,
        errorMessage: null,
        causeMessage: null,
      });
    } catch (e) {
      const err = e as Error & { cause?: Error };
      attempts.push({
        label,
        url,
        ok: false,
        status: null,
        elapsedMs: Date.now() - started,
        bodyExcerpt: null,
        errorName: err.name,
        errorMessage: err.message,
        causeMessage: err.cause?.message ?? null,
      });
    }
  }

  return json({
    env: {
      PYRELAY_URL: base ?? null,
      PYRELAY_AUTH_set: !!sharedAuth,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      host,
    },
    dns: dnsResults,
    attempts,
  });
}
