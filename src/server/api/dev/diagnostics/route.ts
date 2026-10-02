import { json } from "@/server/http";
import { checkDevPassword, communism, hubRequests, pyrelay, swaps } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { redact, type DiagnosticsSection } from "@/node/diagnostics";

// GET /api/dev/diagnostics — the text an owner copies for whoever helps them:
// versions, the computer, settings, proxies, accounts, the status and the
// newest log lines, with emails, passwords, proxy logins, tokens and codes
// taken out (src/node/diagnostics.ts). The site adds what only it knows.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const sw = swaps()?.status();
  const cs = communism()?.status();
  const site = { communismError: cs?.lastError ?? null, frozen: !!sw?.limits?.frozen };
  const lines: string[] = [];
  try {
    const db = getDb();
    const open = (table: string) => db.prepare(`SELECT COUNT(*) AS n, SUM(status = 'claimed') AS c FROM ${table} WHERE status IN ('pending','claimed')`).get() as { n: number; c: number | null };
    const dep = open("deposit_requests");
    const wd = open("withdraw_requests");
    lines.push(`Open requests: ${dep.n} deposit(s), ${wd.n} withdraw(s), ${(dep.c ?? 0) + (wd.c ?? 0)} claimed by a bot`);
  } catch (e) {
    lines.push(`Open requests: could not be read (${(e as Error).message})`);
  }
  if (sw) lines.push(`Player meetings open: ${sw.rendezvous.filter((r) => r.state === "meet" || r.localState === "meet").length}${sw.limits?.frozen ? "; the rotmg trade team froze this node's offers" : ""}`);
  if (cs) lines.push(`Communism: ${cs.accounts.length} account(s), ${cs.items.length} item(s); free slots ${cs.room.seasonal.free} seasonal, ${cs.room.nonseasonal.free} non-seasonal${cs.lastError ? `; last error: ${cs.lastError}` : ""}`);
  const hr = hubRequests()?.status();
  if (hr) lines.push(`Requests from rotmg trade users (recent): ${hr.recent.length}`);
  const extra: DiagnosticsSection[] = [{ title: "Website side", lines }];
  const r = await pyrelay.diagnostics({ site, extra });
  if (r.ok) return json(r.data, { headers: { "Cache-Control": "no-store" } });
  // The bots' part did not answer: what the site knows, and why.
  const text = ["rotmg trade node: diagnostics", "", "== Website side ==", ...lines, "", `The bots' part of the app did not answer: ${r.error}`].join("\n");
  return json({ ok: true, text: redact(text) + "\n" }, { headers: { "Cache-Control": "no-store" } });
}
