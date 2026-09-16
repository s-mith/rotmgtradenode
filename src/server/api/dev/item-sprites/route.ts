import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { realmItemById } from "@/lib/sprites";


// Cap per request. Sprites are ~1.5 KB of base64 each, so this bounds a
// response at roughly 300 KB however the caller batches. The console asks
// only for ids it has never seen, and there are ~2000 items in the game
// total, so in practice a batch is a handful.
const MAX_IDS = 200;

// GET /api/dev/item-sprites?ids=2639,3010
//
// Realm type id -> { name, sprite }. Split out from /api/dev/inventories on
// purpose: that endpoint is polled every 1.5s, and inlining sprites there
// would put a couple of hundred KB of base64 on every tick that anything in
// the fleet moved — which would defeat the `rev`/`unchanged` design the whole
// tab is built around.
//
// Sprites are immutable, so the browser caches what it fetches for the life
// of the tab and never asks twice. The long Cache-Control does the same
// across reloads; the id set is in the URL, so distinct batches can't collide.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0),
    ),
  ].slice(0, MAX_IDS);

  const items: Record<string, { name: string; sprite: string | null }> = {};
  for (const id of ids) {
    const hit = realmItemById(id);
    // Unknown ids are answered explicitly rather than omitted, so the client
    // can cache the miss. Otherwise every poll would re-ask for the same
    // handful of items the asset file doesn't have.
    items[String(id)] = hit ?? { name: `#${id}`, sprite: null };
  }

  return json(
    { ok: true, items },
    { headers: { "Cache-Control": "private, max-age=86400, immutable" } },
  );
}
