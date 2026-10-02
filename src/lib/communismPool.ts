import type { PyrelayPool } from "./devauth";

// Communism on this node is whatever sits on the accounts the operator set
// aside for it (botMeta.communism). The pool is everything else. These helpers
// split the fleet's live view the same way everywhere.

export function isCommunismBot(meta: { communism?: boolean } | undefined): boolean {
  return !!meta?.communism;
}

/** Every instance (on a character or in storage) held by a communism account. */
export function communismInstanceIds(pool: PyrelayPool | null): Set<string> {
  const out = new Set<string>();
  if (!pool) return out;
  const meta = pool.botMeta ?? {};
  for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
    if (!isCommunismBot(meta[botGuid])) continue;
    for (const info of Object.values(slots)) out.add(info.instanceId);
  }
  for (const [botGuid, stored] of Object.entries(pool.stored ?? {})) {
    if (!isCommunismBot(meta[botGuid])) continue;
    for (const s of stored) out.add(s.instanceId);
  }
  return out;
}
