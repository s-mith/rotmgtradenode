import { json } from "@/server/http";
import { checkDevPassword, swaps } from "@/lib/devauth";
import { parseWantInput } from "@/lib/offers";
import { ITEM_BY_ID } from "@/lib/catalog";
import { WITHDRAW_SERVERS } from "@/lib/servers";
import type { OfferWire } from "@/shared/hubWire";

// GET  /api/dev/offers?view=held|browse|mine|status
// POST /api/dev/offers  { action: "create", instanceIds, want, server }
//                       { action: "preview", offer }      what I'd give for it
//                       { action: "accept", offer }
//                       { action: "cancel", offerId }
//                       { action: "poll" }
const names = (o: OfferWire) => ({
  ...o,
  give: o.give.map((g) => ({ ...g, name: ITEM_BY_ID.get(g.itemId)?.name ?? g.itemId })),
  want: o.want.map((w) => ({ ...w, name: ITEM_BY_ID.get(w.itemId)?.name ?? w.itemId })),
});

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const s = swaps();
  if (!s) return json({ error: "swaps are not running (the fleet is off)" }, { status: 503 });
  const view = new URL(req.url).searchParams.get("view") ?? "status";
  if (view === "held") return json({ ok: true, items: s.held(), servers: WITHDRAW_SERVERS });
  if (view === "browse" || view === "mine") {
    const r = view === "browse" ? await s.browse() : await s.mine();
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json({ ok: true, offers: r.offers.map(names), limits: r.limits });
  }
  return json({ ok: true, ...s.status() });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const s = swaps();
  if (!s) return json({ error: "swaps are not running (the fleet is off)" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { action?: string; instanceIds?: unknown; want?: unknown; server?: unknown; offer?: OfferWire; offerId?: unknown } | null;
  if (!body) return json({ error: "Bad JSON" }, { status: 400 });
  switch (body.action) {
    case "create": {
      const want = parseWantInput(body.want);
      if (!want.ok) return json({ error: want.error }, { status: 400 });
      const server = String(body.server ?? "");
      if (!WITHDRAW_SERVERS.includes(server)) return json({ error: "Pick a server" }, { status: 400 });
      const ids = Array.isArray(body.instanceIds) ? body.instanceIds.map(String) : [];
      const r = await s.createOffer({ instanceIds: ids, want: want.want, server });
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, offer: names(r.offer) });
    }
    case "preview": {
      if (!body.offer) return json({ error: "offer required" }, { status: 400 });
      const pv = s.preview(body.offer);
      return json(pv.ok ? { ok: true, picks: pv.picks } : { ok: false, error: pv.error });
    }
    case "accept": {
      if (!body.offer) return json({ error: "offer required" }, { status: 400 });
      const r = await s.acceptOffer(body.offer);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, rendezvous: r.rendezvous });
    }
    case "cancel": {
      const r = await s.cancelOffer(Number(body.offerId));
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true });
    }
    case "poll":
      await s.poll();
      return json({ ok: true, ...s.status() });
    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
}
