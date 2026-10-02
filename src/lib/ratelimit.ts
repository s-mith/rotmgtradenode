
type Bucket = { tokens: number; updated: number };

declare global {
  // eslint-disable-next-line no-var
  var __rl_buckets__: Map<string, Bucket> | undefined;
}

function buckets() {
  if (!globalThis.__rl_buckets__) globalThis.__rl_buckets__ = new Map();
  return globalThis.__rl_buckets__;
}

/** The connection's own address per request, noted by the HTTP adapter (h() in server/http.ts). */
const socketAddresses = new WeakMap<Request, string>();
export function noteSocketAddress(req: Request, address: string | undefined): void {
  if (address) socketAddresses.set(req, address);
}

/** Whether a peer may speak for the client through X-Real-IP / X-Forwarded-For: loopback (a local reverse proxy, Vite's dev proxy) or one listed in TRUSTED_PROXIES. */
function trustedProxy(address: string): boolean {
  const a = address.replace(/^::ffff:/, "");
  if (a === "::1" || /^127\./.test(a)) return true;
  return (process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(a);
}

// Trust order: x-real-ip first (proxy sets it, one hop, not user-controllable),
// then the RIGHTMOST entry of x-forwarded-for (= the closest hop to us, which
// the proxy appended). Taking the leftmost would let any caller spoof a fresh
// rate-limit bucket per request by sending their own X-Forwarded-For. With
// neither (reached directly, or through a proxy that sets no header), the
// connection's own address, so players are not all one bucket.
//
// The headers only count when the connection comes from a trusted proxy.
// Reached directly (a LAN bind), anyone could send them and get a fresh
// bucket per request, so the socket's own address is used instead.
export function clientIp(req: Request): string {
  const socket = socketAddresses.get(req);
  if (socket && !trustedProxy(socket)) return socket;
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return socket ?? "unknown";
}

// Token bucket: `capacity` tokens, refilled at `refillPerSec`.
// Returns true if the request is allowed and consumes 1 token.
//
// IMPORTANT: this function must remain synchronous (no `await`) so the
// read-modify-write of the bucket is atomic under Node's single-threaded
// event loop. Introducing an await in here would let two concurrent
// requests both observe the same token count and both pass, breaking
// the limit. If you need async work (e.g. a Redis backend), wrap this
// behind a queue or use atomic ops on the backend itself.
export function rateLimit(
  key: string,
  capacity: number,
  refillPerSec: number,
): boolean {
  const map = buckets();
  const now = Date.now();
  const b = map.get(key) ?? { tokens: capacity, updated: now };
  const elapsed = (now - b.updated) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
  b.updated = now;
  const allowed = b.tokens >= 1;
  if (allowed) b.tokens -= 1;
  map.set(key, b);

  // Cheap GC so the map doesn't grow unbounded. Runs on the deny path too —
  // it used to sit after an early `return false`, so it never fired during
  // exactly the traffic that grows the map fastest (a flood of throttled
  // requests from many IPs).
  if (map.size > 5000) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [k, v] of map) if (v.updated < cutoff) map.delete(k);
  }
  return allowed;
}
