import { useCallback, useEffect, useState } from "react";
import CommunismPanel from "@/components/CommunismPanel";
import type { CommunismAccountView } from "@/components/Vault";

// Communism from the operator's side: the hub side — other nodes' items,
// hand-overs, what hub users asked for. Which accounts are set aside for it
// is the "communism" tick on each card under Accounts (confirmCommunismChange
// below is that tick's confirm). The player-facing view (the grid, deposits
// and withdraws) is the Communism bookmark on the main page.

/** The confirm every communism switch goes through: what it exposes or takes back, in numbers. */
export function confirmCommunismChange(a: { ign: string; alias: string; held: number; stored: number; communism: boolean }, next: boolean): boolean {
  const name = a.ign || a.alias;
  if (next) {
    return confirm(`Put ${name} in communism?\n\nEverything on it becomes free for anyone on the hub to take: ${a.held} item${a.held === 1 ? "" : "s"} on its character and ${a.stored} in its storage. Its slots become communism room, and it stops doing pool work. You can take it back any time.`);
  }
  return confirm(`Take ${name} back into your pool?\n\nIt stops being a communism account; the ${a.held + a.stored} item${a.held + a.stored === 1 ? "" : "s"} on it are yours again and leave the hub's board on the next publish.`);
}

export default function CommunismTab() {
  const [communismAccounts, setCommunismAccounts] = useState<CommunismAccountView[]>([]);
  const [error, setError] = useState("");
  const [seasonal, setSeasonal] = useState(true);

  const load = useCallback(async () => {
    try {
      const c = await fetch("/api/communism", { cache: "no-store" });
      const cb = await c.json();
      if (!c.ok) throw new Error(cb.error || `HTTP ${c.status}`);
      setCommunismAccounts(cb.accounts);
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="dev-overview">
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      <section className="dev-card">
        <h3>Across the hub <span className="pool-tabs" style={{ display: "inline-flex", margin: "0 0 0 12px", padding: 0, border: 0, gap: 10 }}>
          <button className={"nav-link" + (seasonal ? " active" : "")} onClick={() => setSeasonal(true)}>seasonal</button>
          <button className={"nav-link" + (!seasonal ? " active" : "")} onClick={() => setSeasonal(false)}>non-seasonal</button>
        </span></h3>
        <p className="muted" style={{ marginTop: 0 }}>Which accounts are set aside for communism is the &quot;communism&quot; tick on each card under Accounts.</p>
        <CommunismPanel seasonal={seasonal} accounts={communismAccounts} onChanged={() => void load()} />
      </section>
    </div>
  );
}
