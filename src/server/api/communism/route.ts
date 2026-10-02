import { json } from "@/server/http";
import { communism } from "@/lib/devauth";
import { pyrelay } from "@/lib/devauth";
import { projectInstances } from "@/lib/pool";
import { communismInstanceIds, isCommunismBot } from "@/lib/communismPool";

// GET /api/communism — this node's communism for the main page: the accounts
// set aside for it, the room per pool half, and the items on them in the
// pool grid's own instance shape (lib/pool.ts). No session needed: the
// communism is public by nature.
export async function GET() {
  const r = await pyrelay.pool();
  if (!r.ok) return json({ error: "Bot service unavailable — try again in a minute." }, { status: 503 });
  const pool = r.data;
  const c = communism();
  const inCommunism = communismInstanceIds(pool);
  // projectInstances excludes what it is told to; here the pool's instances are the excluded set.
  const notCommunism = new Set<string>();
  for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) if (!isCommunismBot(pool.botMeta?.[botGuid])) for (const info of Object.values(slots)) notCommunism.add(info.instanceId);
  for (const [botGuid, stored] of Object.entries(pool.stored ?? {})) if (!isCommunismBot(pool.botMeta?.[botGuid])) for (const s of stored) notCommunism.add(s.instanceId);
  const instances = projectInstances(pool, notCommunism).filter((i) => inCommunism.has(i.instanceId));
  return json({
    ok: true,
    linked: c ? c.status().linked : false,
    accounts: c ? c.accounts() : [],
    room: c ? { seasonal: c.room(true), nonseasonal: c.room(false) } : { seasonal: { accounts: 0, slots: 0, used: 0, free: 0 }, nonseasonal: { accounts: 0, slots: 0, used: 0, free: 0 } },
    instances,
  });
}
