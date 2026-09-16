// API keys for the third-party automation endpoints (/api/ext/*).
//
// These are for the handful of people who run their own depositing bots: they
// can't hold a session cookie (that's minted by an in-game /tell challenge in
// a browser), so a static key stands in for it. Keys live only in the env —
// there is no self-service issuance and no database table. To add someone,
// append to EXT_API_KEYS and redeploy; to revoke, delete their entry.
//
//   EXT_API_KEYS="alice:sk_live_9f2c…,bob:sk_live_71ad…"
//
// The label before the colon is cosmetic — it names the caller in rate-limit
// buckets and server logs so one noisy integration can be identified without
// grepping for the secret itself. A bare key with no label is accepted and
// labelled by its first 6 characters.
//
// IMPORTANT: a key authenticates the INTEGRATION, not a character. Unlike a
// session cookie, it carries no proof that the caller controls the IGN it
// names, so a key holder can queue a deposit crediting any IGN. That's fine
// for what this does — a deposit only ever gives items TO the pool, and the
// caller is the one handing them over — but it is exactly why /api/ext has no
// withdraw counterpart. Withdraws take items OUT, so they stay behind the
// session login.
import { createHash, timingSafeEqual } from "node:crypto";

// Anything shorter is a typo or a placeholder, not a secret. Rejected at parse
// time (with a log line) rather than silently accepted — a 4-character key in
// prod is worse than no endpoint at all.
const MIN_KEY_LENGTH = 24;

export type ApiCaller = { label: string };

type KeyTable = { hash: Buffer; label: string }[];

declare global {
  // eslint-disable-next-line no-var
  var __ext_api_keys__: { raw: string; table: KeyTable } | undefined;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/**
 * Parse EXT_API_KEYS into digest/label pairs. Memoized on the raw env string,
 * so it re-parses if the value ever changes under us but costs nothing per
 * request.
 */
function keyTable(): KeyTable {
  const raw = process.env.EXT_API_KEYS ?? "";
  const cached = globalThis.__ext_api_keys__;
  if (cached && cached.raw === raw) return cached.table;

  const table: KeyTable = [];
  for (const entry of raw.split(/[,\s]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Split on the FIRST colon only — the key itself may contain colons.
    const colon = trimmed.indexOf(":");
    const label = colon > 0 ? trimmed.slice(0, colon) : "";
    const key = colon > 0 ? trimmed.slice(colon + 1) : trimmed;
    if (key.length < MIN_KEY_LENGTH) {
      console.warn(
        `[apiKeys] ignoring EXT_API_KEYS entry ${label ? `"${label}"` : "(unlabelled)"}: ` +
          `key is ${key.length} chars, minimum is ${MIN_KEY_LENGTH}`,
      );
      continue;
    }
    table.push({ hash: sha256(key), label: label || key.slice(0, 6) });
  }
  globalThis.__ext_api_keys__ = { raw, table };
  return table;
}

/** Pull the presented key out of either accepted header. */
function presentedKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1]!.trim();
  return (req.headers.get("x-api-key") ?? "").trim();
}

export type ApiKeyResult =
  | { ok: true; caller: ApiCaller }
  | { ok: false; status: number; error: string };

/**
 * Authenticate an /api/ext request.
 *
 * Compares SHA-256 digests rather than the keys themselves so the comparison
 * is fixed-width (timingSafeEqual throws on a length mismatch, which would
 * otherwise leak the length of the configured key). Every configured key is
 * compared against, with no early exit, so the time taken doesn't reveal which
 * entry matched.
 */
export function checkApiKey(req: Request): ApiKeyResult {
  const table = keyTable();
  if (table.length === 0) {
    return { ok: false, status: 503, error: "API access is not configured" };
  }
  const presented = presentedKey(req);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      error: "Missing API key — send Authorization: Bearer <key> or X-Api-Key: <key>",
    };
  }
  const digest = sha256(presented);
  let match: ApiCaller | null = null;
  for (const entry of table) {
    if (timingSafeEqual(digest, entry.hash)) match = { label: entry.label };
  }
  if (!match) return { ok: false, status: 401, error: "Invalid API key" };
  return { ok: true, caller: match };
}
