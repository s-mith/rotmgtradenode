import { createHash } from "node:crypto";

/** Stable public id for a bot account: sha256(email) as base64url, 32 chars.
 *  Same derivation as pyrelay, so the website's `bots` table keeps joining. */
export function deriveBotGuid(email: string): string {
  return createHash("sha256").update(email, "utf8").digest("base64url").slice(0, 32);
}
