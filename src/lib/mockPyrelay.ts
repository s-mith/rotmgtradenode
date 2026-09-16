// DEV-ONLY mock of pyrelay's login-code side, so the whole login flow works
// locally without a real bot fleet. It mirrors Communism/LoginCode.py: the site
// registers a minted code, the (fake) chat client "sends a tell", and we bind
// the code to the sender; the site polls until verified. See the routes under
// src/app/api/mock-pyrelay/ and the chat client at /dev/chat.
//
// Every route that uses this refuses to run when NODE_ENV === "production"
// (devOnlyGuard) — the send-tell path lets any caller claim any IGN, which must
// never be reachable in prod.

const EXPECT_TTL_MS = 180_000;
const VERIFIED_TTL_MS = 120_000;
const CODE_RE = /^[A-Za-z0-9]{4,32}$/;

// The fake login-desk bot the mock always elects.
export const MOCK_BOT_IGN = "VultureBee";

const expected = new Map<string, number>(); // code -> expiresAt
const verified = new Map<string, { ign: string; expiresAt: number }>();

/** True in production — callers should 404 rather than expose the mock. */
export function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export function register(code: string): void {
  expected.set(code, Date.now() + EXPECT_TTL_MS);
}

/**
 * A pasted "/tell <bot> …" reaches us as { name: sender, text: message }. Scan
 * the words for a live registered code and bind it to the sender — same logic
 * as the real note_tell. Returns true when a code matched.
 */
export function noteTell(name: string, text: string): boolean {
  const now = Date.now();
  for (const token of text.trim().split(/\s+/)) {
    if (!CODE_RE.test(token)) continue;
    const exp = expected.get(token);
    if (exp === undefined || exp <= now) continue;
    expected.delete(token);
    verified.set(token, { ign: name, expiresAt: now + VERIFIED_TTL_MS });
    return true;
  }
  return false;
}

/** Poll target: verified (single-use) | pending | expired. */
export function state(code: string): { state: "verified" | "pending" | "expired"; ign: string | null } {
  const now = Date.now();
  const v = verified.get(code);
  if (v && v.expiresAt > now) {
    verified.delete(code);
    return { state: "verified", ign: v.ign };
  }
  const e = expected.get(code);
  if (e !== undefined && e > now) return { state: "pending", ign: null };
  return { state: "expired", ign: null };
}
