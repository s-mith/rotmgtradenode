// Small adapter between Hono and the route handlers that came over from
// Next. Handlers keep the shape `(req: Request, ctx: { params }) => Response`
// so their bodies didn't have to change; `h()` wraps one into a Hono handler.
import type { Context } from "hono";
import { noteSocketAddress } from "@/lib/ratelimit";

export type RouteContext<P = Record<string, string>> = { params: P };
export type RouteHandler<P = Record<string, string>> = (
  req: Request,
  ctx: RouteContext<P>,
) => Response | Promise<Response>;

/** Wrap a route handler for Hono. `P` is whatever the route file declares
 *  for its params; the registry pairs it with a matching `:name` path. */
export function h<P = Record<string, string>>(fn: RouteHandler<P>) {
  return (c: Context) => {
    // @hono/node-server hands over the Node request as `incoming`: its socket's address is the per-IP limits' last resort (lib/ratelimit).
    noteSocketAddress(c.req.raw, (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress);
    return fn(c.req.raw, { params: c.req.param() as unknown as P });
  };
}

/** Whether the client takes gzip (an explicit q=0 opts out). Browsers all do; some scripts don't. */
export function acceptsGzip(header: string | null | undefined): boolean {
  if (!header) return false;
  for (const part of header.split(",")) {
    const [enc, ...params] = part.trim().split(";");
    if (enc.trim().toLowerCase() !== "gzip") continue;
    const q = params.map((s) => s.trim()).find((s) => s.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

/** True when an If-None-Match header names this entity tag (weak or strong). */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

/** JSON response. Drop-in for the old NextResponse.json(body, init). */
export function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

/** Read one cookie off a request, or undefined. */
export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
};

/** Serialize a Set-Cookie header value. maxAge 0 clears the cookie. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
  return parts.join("; ");
}

/** Attach a Set-Cookie header to a response. */
export function setCookie(res: Response, name: string, value: string, opts?: CookieOptions): Response {
  res.headers.append("Set-Cookie", serializeCookie(name, value, opts));
  return res;
}
