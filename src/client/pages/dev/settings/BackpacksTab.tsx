import { useCallback, useEffect, useState } from "react";
// Backpacks (docs/relay/BACKPACKS.md): what the node knows about each
// account's backpack day and character, the season/month clocks, the
// demand-driven claim plan, and the two runs: the HTTP audit and the in-game
// chore. Nothing runs by itself; every run is started here and polled while
// it lasts. There is no daily-login lane and no recycle lane on a node
// (design doc §2): accounts log in when the owner uses them.

type Run = { running: boolean; mode: string | null; startedAt: number | null; finishedAt: number | null; total: number; done: number; ok: number; failed: number; skipped: number; current: string[]; stoppedReason: string | null; lastErrors: { alias: string; error: string }[] };
type Status = {
  clocks: { serverTime: number | null; monthResetsAt: number | null; season: { name: string; end: number } | null; seasonEndsBeforeMonth: boolean | null };
  summary: { accounts: number; audited: number; withBackpack: number; seasonal: number; dead: number; claimableDays: number; claimableBackpacks: number; banked: number; vaultVisited: number; loggedToday: number };
  audit: Run; chore: Run;
  seasonWatch?: { season: { name: string; end: number } | null; rolledSeasonId: string | null; endsInS: number | null; lastRoll: { at: number; seasonId: string; changed: number; total: number } | null; lastFetchError: string | null };
};
type PoolPlan = { pool: string; bots: number; stock: number; bufferItems: number; bufferMode: string; gainPerDay: number | null; horizonDays: number; backpackBots: number; needBots: number; deficit: number; candidates: number; picks: { alias: string; held: number }[] };
type Plan = { seasonal: PoolPlan; nonseasonal: PoolPlan; vaults?: PoolPlan; buffer: number; rows: number };

const POLL_MS = 5000;
const when = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—");
const days = (s: number | null | undefined) => (s === null || s === undefined ? "—" : `${(s / 86_400).toFixed(1)} d`);

export default function BackpacksTab({ password }: { password: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [buffer, setBuffer] = useState("0.2");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const headers = { "X-Dev-Password": password, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        fetch("/api/dev/backpacks?view=status", { headers }).then((r) => r.json()),
        fetch(`/api/dev/backpacks?view=plan&buffer=${encodeURIComponent(buffer)}`, { headers }).then((r) => r.json()),
      ]);
      if (s.error) setError(s.error);
      else setStatus(s as Status);
      if (!p.error) setPlan(p.plan as Plan);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password, buffer]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const anyRunning = status?.audit.running || status?.chore.running;
    if (!anyRunning) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [status, load]);

  async function act(action: string, extra: Record<string, unknown> = {}, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { action, ...extra };
      if (limit.trim()) body.limit = Number(limit);
      const r = await fetch("/api/dev/backpacks", { method: "POST", headers, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) setError(data.error || `HTTP ${r.status}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void load();
    }
  }

  const run = (label: string, r: Run | undefined, cancelAction: string) => (
    <div style={{ marginTop: 8 }}>
      <b>{label}</b>: {r?.running ? `running (${r.done}/${r.total}, ok ${r.ok}, failed ${r.failed}, skipped ${r.skipped}; now ${r.current.join(", ") || "…"})` : r?.finishedAt ? `last run ${when(r.finishedAt)} — ok ${r.ok}, failed ${r.failed}, skipped ${r.skipped}${r.stoppedReason ? ` (${r.stoppedReason})` : ""}` : "never run"}
      {r?.running && <button onClick={() => void act(cancelAction)} disabled={busy} style={{ marginLeft: 8 }}>cancel</button>}
      {r && r.lastErrors.length > 0 && <div style={{ color: "var(--muted, #999)", fontSize: 12 }}>last errors: {r.lastErrors.slice(-3).map((e) => `${e.alias}: ${e.error}`).join(" · ")}</div>}
    </div>
  );
  const poolRow = (p: PoolPlan) => (
    <tr key={p.pool}>
      <td>{p.pool}</td><td>{p.bots}</td><td>{p.stock}</td><td>{p.bufferItems} ({p.bufferMode}{p.gainPerDay !== null ? `, ${p.gainPerDay.toFixed(1)}/day × ${p.horizonDays} d` : ""})</td>
      <td>{p.backpackBots}</td><td>{p.needBots}</td><td style={{ fontWeight: p.deficit ? 600 : 400 }}>{p.deficit}</td><td>{p.candidates}</td>
      <td>{p.picks.length ? p.picks.slice(0, 8).map((x) => `${x.alias} (${x.held})`).join(", ") + (p.picks.length > 8 ? ` … +${p.picks.length - 8}` : "") : "—"}</td>
    </tr>
  );
  const c = status?.clocks;
  const s = status?.summary;
  const picks = plan ? plan.seasonal.picks.length + plan.nonseasonal.picks.length : 0;

  return (
    <section>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 720 }}>
        A 16-slot backpack doubles what one of your accounts can hold (8 + 16 = 24 slots per trade). Backpacks come from the daily-login calendar; the
        audit (HTTP only) refreshes what the node knows, the plan says which accounts are worth fitting, and the chore logs each picked account in,
        claims its backpack day and equips it. Run a dry chore before a live one.
      </p>
      <div style={{ marginTop: 12 }}>
        <b>Clocks</b>: season {c?.season ? `${c.season.name} ends ${when(c.season.end)}` : "unknown"} · month resets {when(c?.monthResetsAt)} · {c?.seasonEndsBeforeMonth === null || c?.seasonEndsBeforeMonth === undefined ? "" : c.seasonEndsBeforeMonth ? "season ends before the month (claims on seasonal-bound accounts may wait)" : "month resets first"}
        {status?.seasonWatch && <span> · rollover watcher: {status.seasonWatch.season ? `${days(status.seasonWatch.endsInS)} left` : "no clock yet"}{status.seasonWatch.lastRoll ? `, last roll ${when(status.seasonWatch.lastRoll.at)} (${status.seasonWatch.lastRoll.changed} flipped)` : ""}</span>}
      </div>
      <div style={{ marginTop: 8 }}>
        <b>Roster</b>: {s ? `${s.audited}/${s.accounts} audited · ${s.withBackpack} with a backpack · ${s.seasonal} seasonal · ${s.claimableBackpacks} backpacks claimable on ${s.claimableDays} accounts · ${s.banked} banked (${s.vaultVisited} vaults read) · ${s.loggedToday} logged in today` : "…"}
      </div>
      <div style={{ marginTop: 16 }}>
        <b>Plan</b> (buffer <input value={buffer} onChange={(e) => setBuffer(e.target.value)} style={{ width: 48 }} /> of stock until growth is measured)
        <div style={{ overflowX: "auto" }}>
          <table style={{ marginTop: 6, fontSize: 13 }}>
            <thead><tr><th>pool</th><th>bots</th><th>stock</th><th>headroom</th><th>at 16</th><th>need</th><th>deficit</th><th>candidates</th><th>claim + equip on</th></tr></thead>
            <tbody>{plan ? [poolRow(plan.nonseasonal), poolRow(plan.seasonal), ...(plan.vaults ? [poolRow(plan.vaults)] : [])] : null}</tbody>
          </table>
        </div>
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span>limit <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="all" style={{ width: 56 }} /></span>
        <button disabled={busy} onClick={() => void act("audit")}>Audit (HTTP)</button>
        <button disabled={busy} onClick={() => void act("audit", { unauditedOnly: true })}>Audit new accounts only</button>
        <button disabled={busy || !picks} onClick={() => void act("chore", { mode: "dry", plan: true, buffer: Number(buffer) })}>Dry chore from plan ({picks})</button>
        <button disabled={busy || !picks} onClick={() => void act("chore", { mode: "live", plan: true, buffer: Number(buffer) }, `Claim and equip backpacks on the ${picks} account(s) the plan picks? This logs each one into the game, claims its backpack day and uses a backpack from the Gift Chest.`)}>Live chore from plan ({picks})</button>
        <button disabled={busy} onClick={() => void load()}>refresh</button>
      </div>
      {run("Audit", status?.audit, "cancel-audit")}
      {run("Chore", status?.chore, "cancel-chore")}
    </section>
  );
}
