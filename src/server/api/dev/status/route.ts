import { json } from "@/server/http";
import { checkDevPassword, communism, pyrelay, swaps } from "@/lib/devauth";
import { buildStatus } from "@/node/status";

// GET /api/dev/status — the node's state in words for the status card: what
// it is doing, and each thing that needs the owner with a button that fixes
// it (src/node/status.ts). The fleet's facts plus the site's own: a node the
// hub's team froze, and communism's last error.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const r = await pyrelay.statusFacts();
  if (!r.ok) {
    // Said as a status too, so the card has words for it; `error` is for whoever helps.
    return json({
      ok: true, state: "problem", headline: "The bots' part of the app isn't answering",
      sub: "Restart the app. If it keeps happening, copy the diagnostics from the Help page and send them to whoever helps you.",
      problems: [], error: r.error,
    }, { headers: { "Cache-Control": "no-store" } });
  }
  const sw = swaps()?.status();
  const cs = communism()?.status();
  const status = buildStatus({ ...r.data.facts, site: { communismError: cs?.lastError ?? null, frozen: !!sw?.limits?.frozen } });
  return json(status, { headers: { "Cache-Control": "no-store" } });
}
