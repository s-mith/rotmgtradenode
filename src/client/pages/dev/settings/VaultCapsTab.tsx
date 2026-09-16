import { useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";

// Operator control of how many vault slots every account is entitled to
// (lib/vault.ts). One button raises every cap by a block, the other lowers
// it; the default for accounts yet to be created moves with them.

type Summary = { default: number; block: number; accounts: number; byCap: { cap: number; accounts: number }[] };
type Result = {
  delta: number;
  accounts: number;
  defaultBefore: number;
  defaultAfter: number;
  shrunk: number;
  overAllocated: { userId: number; igns: string[]; total: number; allocated: number }[];
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: 0,
  borderRadius: 6,
  color: "#000",
  fontWeight: 600,
  cursor: "pointer",
};

export default function VaultCapsTab({ password }: { password: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [last, setLast] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/vault-caps", { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setSummary(data as Summary);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  async function bump(delta: number) {
    if (!summary) return;
    const verb = delta > 0 ? "Raise" : "Lower";
    if (!window.confirm(`${verb} every account's vault cap by ${Math.abs(delta)} slots (${summary.accounts} accounts)?`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/dev/vault-caps", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ delta }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setLast(data as Result);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const block = summary?.block ?? 8;

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 640 }}>
        Every account's vault entitlement, moved a block of {block} at a time. Raising leaves the new slots unallocated until the player places them in a vault. Lowering takes the block from unallocated slots first, then from a vault with a whole free block; an account whose vaults are both too full keeps its slots but can't grow either vault until it is back under the cap.
      </p>

      {summary && (
        <div style={{ marginBottom: 16, fontSize: 14 }}>
          <div>
            Default for new accounts: <strong>{summary.default}</strong> slots · {summary.accounts} account{summary.accounts === 1 ? "" : "s"}
          </div>
          <div style={{ color: "var(--muted, #999)", fontSize: 13, marginTop: 4 }}>
            {summary.byCap.map((r) => `${r.accounts} at ${r.cap}`).join(" · ") || "no accounts yet"}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        <button type="button" disabled={busy || !summary} style={buttonStyle} onClick={() => void bump(block)}>
          {busy ? "…" : `Raise all by ${block}`}
        </button>
        <button type="button" disabled={busy || !summary} className="nav-link" onClick={() => void bump(-block)}>
          Lower all by {block}
        </button>
        <button className="nav-link" onClick={() => void load()}>
          refresh
        </button>
      </div>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      {last && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", background: "var(--panel)", maxWidth: 640, fontSize: 13 }}>
          <div>
            {last.delta > 0 ? "Raised" : "Lowered"} {last.accounts} account{last.accounts === 1 ? "" : "s"} by {Math.abs(last.delta)}; default {last.defaultBefore} → {last.defaultAfter}.
            {last.delta < 0 && ` ${last.shrunk} vault${last.shrunk === 1 ? "" : "s"} gave a block back.`}
          </div>
          {last.overAllocated.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: "var(--bad)" }}>Over their cap (too full to give a block back):</div>
              <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                {last.overAllocated.map((o) => (
                  <li key={o.userId}>
                    {o.igns.map((ign) => (
                      <PlayerName key={ign} ign={ign} readable />
                    ))}{" "}
                    <span style={{ color: "var(--muted, #999)" }}>
                      — {o.allocated} allocated, cap {o.total}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
