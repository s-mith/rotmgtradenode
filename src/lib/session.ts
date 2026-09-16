// Player session: a signed, httpOnly cookie that says "this browser proved
// control of IGN X in game" (see lib/loginChallenge.ts for how that proof is
// obtained). It replaces the old free-text IGN field — every request that used
// to trust an IGN typed into a form now reads it from here instead.
//
// The cookie is a bearer credential, so it's HMAC-signed and we only ever trust
// a value whose signature verifies. No server-side session store: the signature
// is the whole guarantee, and there's nothing to revoke beyond letting it
// expire (or clearing the cookie via logout).
import crypto from "node:crypto";
import { getCookie } from "@/server/http";

export const SESSION_COOKIE = "rc_ign";

// 30 days. Long enough that a regular player isn't re-verifying constantly,
// short enough that a stale cookie on a shared machine lapses on its own.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Signing key. Set SESSION_SECRET in prod; locally we fall back to a fixed
// dev-only key so login works out of the box. The fallback is NOT a secret —
// it just keeps a dev machine from needing config; anything user-facing must
// set SESSION_SECRET.
function secret(): string {
  return process.env.SESSION_SECRET || "rotmgcommunism-dev-session-secret-do-not-use-in-prod";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Mint a session cookie value for a verified IGN. */
export function signSession(ign: string): string {
  const payload = `${ign}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a cookie value and return its IGN, or null if it's missing, malformed,
 * tampered, or expired. Signature check is constant-time.
 */
export function verifySession(token: string | undefined | null): { ign: string; ignLower: string } | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  if (
    mac.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  ) {
    return null;
  }
  const sep = payload.lastIndexOf(".");
  if (sep <= 0) return null;
  const ign = payload.slice(0, sep);
  const issuedAt = Number(payload.slice(sep + 1));
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_TTL_MS) return null;
  if (!/^[A-Za-z]{1,32}$/.test(ign)) return null;
  return { ign, ignLower: ign.toLowerCase() };
}

/** Read the verified session IGN off a request's cookies, or null. */
export function sessionFromRequest(req: Request): { ign: string; ignLower: string } | null {
  return verifySession(getCookie(req, SESSION_COOKIE));
}

/** Cookie attributes shared by set (login) and clear (logout). */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);
