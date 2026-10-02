import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { presence } from "@/lib/fleetPresence";
import { checkDevPassword, pyrelay } from "@/lib/devauth";


// GET /api/dev/pool-stats
// Diagnostic: compares the website's view of who's online (bots table)
// against pyrelay's view (live instance map). Useful when the pool looks
// empty or out of date — tells you whether the gap is on the website or
// inside pyrelay.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const db = getDb();
  const websiteBots = presence.all().length;
  const openWithdraws = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM withdraw_requests WHERE status IN ('pending','claimed')",
      )
      .get() as { n: number }
  ).n;

  let pyrelayInstances = 0;
  let pyrelayBots = 0;
  let pyrelayEnchanted = 0;
  let pyrelayErr: string | null = null;
  const samplePerBot: { botGuid: string; ign: string; count: number }[] = [];
  const p = await pyrelay.pool();
  if (!p.ok) {
    pyrelayErr = p.error;
  } else {
    pyrelayBots = Object.keys(p.data.instances ?? {}).length;
    for (const [botGuid, slots] of Object.entries(p.data.instances ?? {})) {
      const slotList = Object.values(slots);
      pyrelayInstances += slotList.length;
      for (const info of slotList) {
        if (info.enchantments && info.enchantments.length > 0) pyrelayEnchanted++;
      }
      const meta = (p.data.botMeta ?? {})[botGuid];
      samplePerBot.push({
        botGuid,
        ign: meta?.ign ?? "",
        count: slotList.length,
      });
    }
    samplePerBot.sort((a, b) => b.count - a.count);
  }

  return json({
    website: {
      bots: websiteBots,
      openWithdraws,
    },
    pyrelay: {
      err: pyrelayErr,
      bots: pyrelayBots,
      instances: pyrelayInstances,
      enchanted: pyrelayEnchanted,
      // Every bot, the fullest first.
      topBots: samplePerBot,
    },
  });
}
