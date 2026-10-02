// Where a meeting is best held when the caller may choose: a random server
// Realm reports empty, as the fleet last read the load (lib/serverUsage.ts).
// Communism takes always choose; a swap taker chooses when the poster's
// server is closed or busy on its node. Pure.

/**
 * The server a meeting meets on: a random one among `candidates` that Realm
 * reports at 0% load; with none at zero, a random one among the least
 * loaded; with no report at all, a random candidate.
 */
export function pickQuietServer(candidates: readonly string[], report: { name: string; usage: number }[] | null, rnd: () => number = Math.random): { server: string; why: string } {
  const pick = (xs: readonly string[]) => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  if (!candidates.length) return { server: "USSouth3", why: "no servers to choose from" };
  const known = report ? candidates.filter((c) => report.some((r) => r.name === c)) : [];
  if (!known.length) return { server: pick(candidates), why: "no load report" };
  const usage = (c: string) => report!.find((r) => r.name === c)!.usage;
  const quiet = known.filter((c) => usage(c) <= 0);
  if (quiet.length) return { server: pick(quiet), why: `${quiet.length} server${quiet.length === 1 ? "" : "s"} at 0%` };
  const least = Math.min(...known.map(usage));
  const low = known.filter((c) => usage(c) === least);
  return { server: pick(low), why: `none at 0%; ${Math.round(least * 100)}% is the least loaded` };
}
