import { createHash } from "node:crypto";
import { etagMatches } from "@/server/http";
import { allEnchants } from "@/lib/enchants";

// GET /api/enchant-catalog
// Full enchant catalog (id, name, sprite) loaded once per page by the vault UI
// for tooltip rendering. Static for the life of the process (realm-enchants.json
// ships in the image), so it is serialized once, tagged, and cacheable for an
// hour; a browser that already has it gets a 304.
let cached: { body: string; etag: string } | null = null;

export async function GET(req: Request): Promise<Response> {
  if (!cached) {
    const body = JSON.stringify({ enchants: allEnchants() });
    cached = { body, etag: `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"` };
  }
  const headers = { ETag: cached.etag, "Cache-Control": "public, max-age=3600", "Content-Type": "application/json; charset=utf-8" };
  if (etagMatches(req.headers.get("if-none-match"), cached.etag)) return new Response(null, { status: 304, headers });
  return new Response(cached.body, { status: 200, headers });
}
