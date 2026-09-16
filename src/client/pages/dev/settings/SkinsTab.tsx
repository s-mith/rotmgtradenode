// Dev console → Skins: bring skins into the pool, see what the fleet holds
// of each (by pool and by bot), and the redemptions players have made.
// Skins are only ever accepted on a deposit queued here: the bot that
// claims it takes skins on that trade and on no other, and they never show
// on the ledger.
import { useCallback, useEffect, useState } from "react";
import { SERVERS } from "../../../../lib/servers";

type SkinRow = { realmId: string; name: string; image: string; count: number; holders: string[]; strays: number; strayHolders: string[] };
type Redemption = { id: number; ign: string; skinId: string; name: string; requestId: number; status: string; botIgn: string | null; createdAt: number };
type DepositStatus = { groupStatus: string; trades: { requestId: number; status: string; botIgn: string | null }[] };

export default function SkinsTab({ password }: { password: string }) {
  const [skins, setSkins] = useState<SkinRow[] | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stockedOnly, setStockedOnly] = useState(true);
  // The operator's own skin deposit: form, then the queued group to follow.
  const [ign, setIgn] = useState(() => {
    try {
      return sessionStorage.getItem("skins_deposit_ign") ?? "";
    } catch {
      return "";
    }
  });
  const [server, setServer] = useState<string>(SERVERS[0]);
  const [count, setCount] = useState("8");
  const [queueing, setQueueing] = useState(false);
  const [depositErr, setDepositErr] = useState("");
  const [deposit, setDeposit] = useState<{ groupId: string; status: DepositStatus | null } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/dev/skins", { headers: { "X-Dev-Password": password }, cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Failed to load skins");
        return;
      }
      setSkins(d.skins ?? []);
      setPoolError(d.poolError ?? null);
      setRedemptions(d.redemptions ?? []);
    } catch {
      setErr("Network error");
    }
  }, [password]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Follow the queued deposit until it ends.
  useEffect(() => {
    if (!deposit || (deposit.status && deposit.status.groupStatus !== "in-flight")) return;
    const groupId = deposit.groupId;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/dev/deposit-skins?groupId=${encodeURIComponent(groupId)}`, { headers: { "X-Dev-Password": password }, cache: "no-store" });
        const d = await r.json();
        if (cancelled || !r.ok) return;
        setDeposit((cur) => (cur && cur.groupId === groupId ? { groupId, status: d as DepositStatus } : cur));
      } catch {
        // transient
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [deposit?.groupId, deposit?.status?.groupStatus, password]);

  async function queueDeposit() {
    setQueueing(true);
    setDepositErr("");
    try {
      sessionStorage.setItem("skins_deposit_ign", ign);
    } catch {
      // storage unavailable
    }
    try {
      const r = await fetch("/api/dev/deposit-skins", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dev-Password": password },
        body: JSON.stringify({ ign, server, slots: Number(count) || 8 }),
      });
      const d = await r.json();
      if (!r.ok) {
        setDepositErr(d.error || `HTTP ${r.status}`);
        return;
      }
      setDeposit({ groupId: d.groupId, status: null });
    } catch (e) {
      setDepositErr(String(e));
    } finally {
      setQueueing(false);
    }
  }

  if (err) return <p style={{ color: "var(--bad)" }}>{err}</p>;
  if (!skins) return <p style={{ color: "var(--muted)" }}>Loading…</p>;

  const q = query.trim().toLowerCase();
  const rows = skins
    .filter((s) => !stockedOnly || s.count + s.strays > 0)
    .filter((s) => !q || s.name.toLowerCase().includes(q));
  const stocked = skins.filter((s) => s.count > 0).length;
  const held = skins.reduce((n, s) => n + s.count, 0);
  const strays = skins.reduce((n, s) => n + s.strays, 0);

  return (
    <section>
      <p style={{ color: "var(--muted)", fontSize: 13, maxWidth: 680, marginBottom: 12 }}>
        Skins are non-seasonal items and are only accepted on a deposit queued here. Queue one for your own
        non-seasonal character, trade the bot it names, and hand over the skins; they never show on the ledger — no
        points, no activity, no depositor. <strong>{held}</strong> held across <strong>{stocked}</strong> of{" "}
        {skins.length} skins.
        {strays > 0 && <span style={{ color: "var(--bad)" }}> {strays} on seasonal bots — unreachable for redemption.</span>}
        {poolError && <span style={{ color: "var(--bad)" }}> Pool unreachable: {poolError}</span>}
      </p>
      <div className="skins-deposit">
        <input value={ign} onChange={(e) => setIgn(e.target.value)} placeholder="Your IGN" className="pool-search" style={{ width: 160 }} />
        <select value={server} onChange={(e) => setServer(e.target.value)}>
          {SERVERS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input type="number" min={1} max={16} value={count} onChange={(e) => setCount(e.target.value)} className="pool-search" style={{ width: 64 }} title="Trade size: the bot that comes has this many free slots (16 needs an empty backpack bot). One trade." />
        <button type="button" className="btn primary" onClick={queueDeposit} disabled={queueing || !ign.trim()}>
          Queue a skin deposit
        </button>
      </div>
      {depositErr && <p style={{ color: "var(--bad)", fontSize: 12, margin: "6px 0 0" }}>{depositErr}</p>}
      {deposit && (
        <p style={{ fontSize: 13, margin: "8px 0 12px" }}>
          {(() => {
            const t = deposit.status?.trades.find((x) => x.status === "claimed" && x.botIgn) ?? null;
            const gs = deposit.status?.groupStatus ?? "in-flight";
            if (gs === "fulfilled") return <span style={{ color: "var(--good)" }}>Skin deposit done.</span>;
            if (gs === "cancelled") return <span style={{ color: "var(--muted)" }}>Skin deposit cancelled (nobody traded in time).</span>;
            if (gs === "partial") return <span style={{ color: "var(--good)" }}>Skin deposit partly done — the rest was cancelled.</span>;
            if (t) return <>Trade <strong>{t.botIgn}</strong> on {server}: <code>/trade {t.botIgn}</code> — it will take skins on this trade.</>;
            return <em style={{ color: "var(--muted)" }}>waiting for a bot to claim your skin deposit…</em>;
          })()}
        </p>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <input type="search" placeholder="Search skins…" value={query} onChange={(e) => setQuery(e.target.value)} className="pool-search" style={{ width: 260 }} />
        <label style={{ fontSize: 13, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={stockedOnly} onChange={(e) => setStockedOnly(e.target.checked)} /> in stock only
        </label>
      </div>
      <table className="skins-table">
        <thead>
          <tr>
            <th></th>
            <th>Skin</th>
            <th>Held</th>
            <th>Held by</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((s) => (
            <tr key={s.realmId}>
              <td><img src={s.image} alt="" width={28} height={28} style={{ imageRendering: "pixelated", objectFit: "contain" }} /></td>
              <td>{s.name}</td>
              <td className="num">{s.count || ""}</td>
              <td style={{ color: "var(--muted)" }}>
                {s.holders.join(", ")}
                {s.strays > 0 && <span style={{ color: "var(--bad)" }}> · {s.strays} stray on seasonal {s.strayHolders.join(", ")}</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} style={{ color: "var(--muted)" }}>{stockedOnly ? "No skins in the pool." : "No skins match."}</td></tr>
          )}
        </tbody>
      </table>
      {rows.length > 200 && <p style={{ color: "var(--muted)", fontSize: 12 }}>Showing first 200 — search to narrow.</p>}

      <h3 style={{ marginTop: 20 }}>Redemptions</h3>
      {redemptions.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Nobody has redeemed a skin yet.</p>
      ) : (
        <table className="skins-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Player</th>
              <th>Skin</th>
              <th>Status</th>
              <th>Bot</th>
            </tr>
          </thead>
          <tbody>
            {redemptions.map((r) => (
              <tr key={r.id}>
                <td style={{ color: "var(--muted)" }}>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.ign}</td>
                <td>{r.name}</td>
                <td className={"redeem-status " + r.status}>{r.status}</td>
                <td style={{ color: "var(--muted)" }}>{r.botIgn ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
