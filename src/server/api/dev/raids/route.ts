import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { SERVER_SET } from "@/lib/servers";
import { banRaider, clearStrikes, deleteRaid, endRaid, listRaidBans, listRaidEvents, listRaidsAdmin, listStrikes, raidWatchHook, unbanRaider } from "@/lib/raids";

// Operator console for raids (lib/raids.ts, docs/RAIDS.md).
//
// GET    /api/dev/raids                          — every raid, nothing hidden (watcher state, pops, who was present), the ban list,
//                                                  and the fleet's watchers (`watchersEnabled` false when no fleet hook is registered)
// GET    /api/dev/raids?events=<raid id>         — that raid's audit log
// POST   /api/dev/raids { op: "end", id }        — end a raid at any stage
//        /api/dev/raids { op: "delete", id }     — remove it outright (members and pops go with it; the audit stays)
//        /api/dev/raids { op: "ban", ign, reason? }
//        /api/dev/raids { op: "watch", server, side, minutes } — send a watcher into a bazaar with no raid, to exercise the trip
//        /api/dev/raids { op: "clear_strikes", ign }  — wipe a leader's active strikes (their posting cooldown or block)
// DELETE /api/dev/raids { ign }                  — lift a ban
//
// Same IGN rules as the other consoles (letters only, 1-32 chars).

function parseIgn(v: unknown): { ign: string; ignLower: string } | null {
  const ign = typeof v === "string" ? v.trim() : "";
  if (!ign || ign.length > 32 || !/^[A-Za-z]+$/.test(ign)) return null;
  return { ign, ignLower: ign.toLowerCase() };
}
function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const db = getDb();
  const events = parseId(new URL(req.url).searchParams.get("events"));
  if (events !== null) return json({ ok: true, events: listRaidEvents(db, events) });
  const hook = raidWatchHook();
  return json({ ok: true, raids: listRaidsAdmin(db), bans: listRaidBans(db), strikes: listStrikes(db), watchersEnabled: hook !== null, watchers: hook?.list() ?? [] });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = getDb();
  if (body.op === "end" || body.op === "delete") {
    const id = parseId(body.id);
    if (id === null) return json({ error: "id is required" }, { status: 400 });
    if (body.op === "end") {
      const r = endRaid(db, "operator", id);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, raid: r.raid });
    }
    if (!deleteRaid(db, id)) return json({ error: "No such raid" }, { status: 404 });
    return json({ ok: true });
  }
  if (body.op === "ban") {
    const ign = parseIgn(body.ign);
    if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
    return json({ ok: true, ban: banRaider(db, ign.ign, ign.ignLower, reason) });
  }
  if (body.op === "clear_strikes") {
    const ign = parseIgn(body.ign);
    if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });
    return json({ ok: true, cleared: clearStrikes(db, ign.ignLower, "operator") });
  }
  if (body.op === "watch") {
    const hook = raidWatchHook();
    if (!hook) return json({ error: "No fleet watcher is registered (RAID_WATCHERS unset or the fleet is not embedded)" }, { status: 503 });
    const server = typeof body.server === "string" ? body.server : "";
    if (!SERVER_SET.has(server)) return json({ error: "Pick a server" }, { status: 400 });
    const side = body.side === "right" ? "right" : body.side === "left" ? "left" : null;
    if (!side) return json({ error: "side must be left or right" }, { status: 400 });
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) return json({ error: "minutes must be 1-30" }, { status: 400 });
    return json({ ok: true, key: hook.manual(server, side, minutes), watchers: hook.list() });
  }
  return json({ error: "op must be end, delete, ban, clear_strikes or watch" }, { status: 400 });
}

export async function DELETE(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });
  if (!unbanRaider(getDb(), ign.ignLower)) return json({ error: "No ban found for that IGN" }, { status: 404 });
  return json({ ok: true });
}
