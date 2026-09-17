import { useCallback, useEffect, useState } from "react";
import { ItemSprite } from "@/components/ItemSprite";
// Account storage (docs/relay/STORAGE.md): what each account keeps beyond
// its character's trade slots — the vault chests, the potion rack, the Gift
// Chest, the seasonal spoils chest and the other characters — and the moves
// the operator queues between the containers and the character. A run logs
// the account in, walks it into the Vault, does the moves and reads
// everything back. Everything tradeable here is in the pool already; a
// withdraw naming it has the fleet fetch it by itself. The same tab picks
// which character an account logs in with.

type Move = { id: string; kind: string; itemId: string | null; objectType: number; name: string; instanceId?: string; slot?: number; queuedAt: number; error?: string };
type CharRow = { id: number; objectType: number; className: string; level: number; seasonal: boolean; dead: boolean; backpackSlots: number; hasBackpack: boolean; items: number };
type Counts = { character: { held: number; capacity: number }; vault: { used: number; slots: number }; rack: { used: number; slots: number }; gift: { items: number; tradeable: number }; spoils: { items: number; tradeable: number }; otherChars: number };
type Summary = { alias: string; guid: string; botGuid: string; ign: string; seasonal: boolean; suspended: boolean; busy: boolean; lastVisitAt: number | null; charsAt: number | null; chars: CharRow[] | null; preferredCharId: number | null; loginCharId: number | null; moves: Move[]; lastRun: { at: number; ok: boolean; error: string | null; summary: string } | null; lastError: string | null; counts: Counts };
type SlotRow = { slot: number; objectType: number; itemId: string | null; name: string; tradeable: boolean; instanceId: string | null };
type CharItemRow = { slot: number; instanceId: string; itemId: string; name: string };
type Detail = Summary & { character: { slot: number; instanceId: string; itemId: string; name: string; enchantments: number[]; potion: boolean }[]; untracked: { slot: number; objectType: number; name: string }[]; vault: SlotRow[]; rack: SlotRow[]; gift: SlotRow[]; spoils: SlotRow[]; charItems: Record<string, CharItemRow[]> };
type Run = { running: boolean; startedAt: number | null; finishedAt: number | null; total: number; done: number; ok: number; failed: number; skipped: number; current: string[]; stoppedReason: string | null; lastErrors: { alias: string; error: string }[]; moved: number };

const POLL_MS = 4000;
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z" : "never");
const MOVE_LABEL: Record<string, string> = { bank: "→ vault", unbank: "vault →", rackIn: "→ rack", rackOut: "rack →", giftOut: "gift →", spoilsOut: "spoils →" };

export default function StorageTab({ password }: { password: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [accounts, setAccounts] = useState<Summary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const headers = { "X-Dev-Password": password, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    try {
      const s = await fetch("/api/dev/storage?view=status", { headers, cache: "no-store" }).then((r) => r.json());
      if (s.error) setError(s.error);
      else {
        setRun(s.run as Run);
        setAccounts(s.accounts as Summary[]);
        setError("");
      }
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);
  const loadDetail = useCallback(async (botGuid: string) => {
    try {
      const d = await fetch(`/api/dev/storage?view=account&botGuid=${encodeURIComponent(botGuid)}`, { headers, cache: "no-store" }).then((r) => r.json());
      if (d.error) setError(d.error);
      else setDetail(d.account as Detail);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!run?.running) return;
    const id = setInterval(() => { void load(); if (open) void loadDetail(open); }, POLL_MS);
    return () => clearInterval(id);
  }, [run?.running, open, load, loadDetail]);
  useEffect(() => {
    if (open) void loadDetail(open);
    else setDetail(null);
  }, [open, loadDetail]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) setError(data.error || `HTTP ${r.status}`);
      else if (data.account && open === (data.account as Detail).botGuid) setDetail(data.account as Detail);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void load();
    }
  }
  async function setChar(guid: string, charId: number | null) {
    setBusy(true);
    try {
      const r = await fetch("/api/dev/accounts", { method: "POST", headers, body: JSON.stringify({ action: "set-char", guid, charId }) });
      const data = await r.json();
      if (!r.ok) setError(data.error || `HTTP ${r.status}`);
    } finally {
      setBusy(false);
      void load();
      if (open) void loadDetail(open);
    }
  }
  const queue = (botGuid: string, add: Record<string, unknown>) => void post({ action: "queue", botGuid, add: [add] });

  const rows = (list: SlotRow[], kind: "unbank" | "rackOut" | "giftOut" | "spoilsOut", d: Detail, takeLabel: string) => (
    list.length === 0 ? <p className="hint">empty</p> : (
      <ul className="storage-list">
        {list.map((r) => {
          const queued = d.moves.some((m) => m.kind === kind && m.slot === r.slot);
          const can = r.itemId !== null && (kind === "unbank" || kind === "rackOut" || r.tradeable);
          return (
            <li key={r.slot} className={can ? "" : "muted"}>
              <span className="storage-item"><ItemSprite name={r.name} size={18} /> {r.name}</span>
              <span className="muted"> · slot {r.slot}{!can ? (r.itemId === null ? " · not an item the node trades" : " · not tradeable") : r.instanceId ? " · in the pool" : ""}</span>
              {can && <button className="nav-link" disabled={busy || queued} onClick={() => queue(d.botGuid, { kind, slot: r.slot })}>{queued ? "queued" : takeLabel}</button>}
            </li>
          );
        })}
      </ul>
    )
  );

  return (
    <section>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 760 }}>
        Each account keeps more than its character carries: vault chests (8 slots each), a potion rack, the Gift Chest and the seasonal spoils chest.
        Queue moves below, then run them: the account logs in, walks into the Vault, moves the items and reads every container back. Items in storage
        are not in the pool until they are taken out again. Refresh visits the vault without moving anything.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0 12px" }}>
        <button disabled={busy || run?.running} onClick={() => void post({ action: "run" })}>Run queued moves (all accounts)</button>
        <button disabled={busy || run?.running} onClick={() => void post({ action: "refresh", guids: accounts.filter((a) => !a.suspended).map((a) => a.botGuid) })}>Refresh every account</button>
        {run?.running && <button disabled={busy} onClick={() => void post({ action: "cancel" })}>cancel</button>}
        <button disabled={busy} onClick={() => void load()}>reload</button>
        <span className="hint">
          {run?.running ? `running ${run.done}/${run.total} · now ${run.current.join(", ") || "…"} · ${run.moved} moved` : run?.finishedAt ? `last run ${when(run.finishedAt * 1000)} — ${run.ok} ok, ${run.failed} failed, ${run.skipped} skipped, ${run.moved} moved${run.stoppedReason ? ` (${run.stoppedReason})` : ""}` : "no run yet"}
        </span>
      </div>
      {run && run.lastErrors.length > 0 && <p className="hint" style={{ color: "var(--bad)" }}>{run.lastErrors.slice(-3).map((e) => `${e.alias}: ${e.error}`).join(" · ")}</p>}

      {accounts.map((a) => {
        const c = a.counts;
        const isOpen = open === a.botGuid;
        const d = isOpen ? detail : null;
        return (
          <div key={a.botGuid} className="storage-account" style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 10, opacity: a.suspended ? 0.6 : 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong>{a.alias}</strong>
              {a.ign && a.ign !== a.alias && <span className="muted">· {a.ign}</span>}
              <span className="muted">· {a.seasonal ? "seasonal" : "non-seasonal"}{a.suspended ? " · suspended" : a.busy ? " · busy" : ""}</span>
              <span className="muted">· character {c.character.held}/{c.character.capacity} · vault {c.vault.used}/{c.vault.slots} · rack {c.rack.used}/{c.rack.slots} · gift {c.gift.tradeable} tradeable of {c.gift.items} · spoils {c.spoils.tradeable} of {c.spoils.items}{c.otherChars ? ` · other characters ${c.otherChars}` : ""}</span>
              {a.moves.length > 0 && <span className="tab-badge">{a.moves.length} queued</span>}
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button className="nav-link" disabled={busy || run?.running || a.suspended} onClick={() => void post({ action: "refresh", guids: [a.botGuid] })}>refresh</button>
                <button className="nav-link" disabled={busy || run?.running || a.suspended || a.moves.length === 0} onClick={() => void post({ action: "run", guids: [a.botGuid] })}>run {a.moves.length || ""}</button>
                <button className="nav-link" onClick={() => setOpen(isOpen ? null : a.botGuid)}>{isOpen ? "close" : "open"}</button>
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              vault visited {when(a.lastVisitAt)}{a.lastRun ? ` · last run ${a.lastRun.ok ? "ok" : `failed: ${a.lastRun.error}`}` : ""}{a.lastError && !a.lastRun?.error ? ` · ${a.lastError}` : ""}
            </div>
            {isOpen && !d && <p className="hint">loading…</p>}
            {isOpen && d && (
              <div className="storage-detail" style={{ marginTop: 10, display: "grid", gap: 12 }}>
                {d.moves.length > 0 && (
                  <div>
                    <b>Queued moves</b> <button className="nav-link" disabled={busy} onClick={() => void post({ action: "unqueue", botGuid: d.botGuid })}>clear all</button>
                    <ul className="storage-list">
                      {d.moves.map((m) => (
                        <li key={m.id}>
                          <span className="storage-item"><ItemSprite name={m.name} size={18} /> {m.name}</span>
                          <span className="muted"> {MOVE_LABEL[m.kind] ?? m.kind}{m.slot !== undefined ? ` (slot ${m.slot})` : ""}{m.error ? ` · last run: ${m.error}` : ""}</span>
                          <button className="nav-link" disabled={busy} onClick={() => void post({ action: "unqueue", botGuid: d.botGuid, ids: [m.id] })}>remove</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <b>Characters</b> <span className="muted">{d.charsAt ? `as of ${when(d.charsAt)}` : "unknown until a refresh"}</span>
                  {d.chars && (
                    <ul className="storage-list">
                      {d.chars.map((ch) => {
                        const chosen = d.preferredCharId === ch.id;
                        return (
                          <li key={ch.id}>
                            <span>{ch.className} level {ch.level} · #{ch.id}</span>
                            <span className="muted"> · {ch.seasonal ? "seasonal" : "non-seasonal"} · {ch.backpackSlots ? `${8 + ch.backpackSlots} trade slots` : "8 trade slots, no backpack"}{ch.dead ? " · dead" : ""}{d.loginCharId === ch.id ? " · the one the tracker describes" : ch.items ? ` · ${ch.items} tradeable item(s), in the pool` : ""}</span>
                            {chosen ? <span className="tab-badge">logs in with this one</span> : <button className="nav-link" disabled={busy || ch.dead} onClick={() => void setChar(d.guid, ch.id)}>use this character</button>}
                          </li>
                        );
                      })}
                      {d.preferredCharId !== null && <li><button className="nav-link" disabled={busy} onClick={() => void setChar(d.guid, null)}>back to the first character</button> <span className="muted">(the game's default; a change takes effect at the next login)</span></li>}
                    </ul>
                  )}
                </div>
                <div>
                  <b>On the character</b> <span className="muted">{d.counts.character.held}/{d.counts.character.capacity}</span>
                  {d.character.length === 0 ? <p className="hint">empty</p> : (
                    <ul className="storage-list">
                      {d.character.map((it) => {
                        const queued = d.moves.find((m) => m.instanceId === it.instanceId);
                        return (
                          <li key={it.instanceId}>
                            <span className="storage-item"><ItemSprite name={it.name} size={18} /> {it.name}</span>
                            <span className="muted"> · slot {it.slot}{it.enchantments.length ? ` · ${it.enchantments.length} ench` : ""}</span>
                            {queued ? <span className="muted">queued {MOVE_LABEL[queued.kind]}</span> : (
                              <>
                                <button className="nav-link" disabled={busy} onClick={() => queue(d.botGuid, { kind: "bank", instanceId: it.instanceId })}>put in vault</button>
                                {it.potion && <button className="nav-link" disabled={busy} onClick={() => queue(d.botGuid, { kind: "rackIn", instanceId: it.instanceId })}>put in rack</button>}
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                {d.untracked.length > 0 && (
                  <div>
                    <b>Also on the character</b> <span className="muted">{d.untracked.length} item(s) the node does not trade; they take slots</span>
                    <ul className="storage-list">
                      {d.untracked.map((u) => {
                        const queued = d.moves.some((m) => m.instanceId === undefined && m.slot === u.slot && m.kind === "bank");
                        return (
                          <li key={u.slot} className="muted">
                            <span className="storage-item"><ItemSprite name={u.name} size={18} /> {u.name}</span>
                            <span> · slot {u.slot}</span>
                            <button className="nav-link" disabled={busy || queued} onClick={() => queue(d.botGuid, { kind: "bank", slot: u.slot })}>{queued ? "queued" : "put in vault"}</button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {Object.keys(d.charItems).length > 0 && (
                  <div>
                    <b>On other characters</b> <span className="muted">{d.counts.otherChars} tradeable item(s); in the pool, fetched by a login as that character</span>
                    {Object.entries(d.charItems).map(([id, items]) => {
                      const ch = d.chars?.find((c) => String(c.id) === id);
                      return (
                        <div key={id} style={{ marginTop: 4 }}>
                          <span className="muted">{ch ? `${ch.className} level ${ch.level} · #${ch.id}` : `character #${id}`}</span>
                          <ul className="storage-list">
                            {items.map((it) => (
                              <li key={it.instanceId}>
                                <span className="storage-item"><ItemSprite name={it.name} size={18} /> {it.name}</span>
                                <span className="muted"> · slot {it.slot}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div><b>Vault chests</b> <span className="muted">{d.counts.vault.used}/{d.counts.vault.slots} slots</span>{rows(d.vault, "unbank", d, "take out")}</div>
                <div><b>Potion rack</b> <span className="muted">{d.counts.rack.used}/{d.counts.rack.slots}</span>{rows(d.rack, "rackOut", d, "take out")}</div>
                <div><b>Gift chest</b> <span className="muted">{d.counts.gift.items} items, {d.counts.gift.tradeable} tradeable</span>{rows(d.gift, "giftOut", d, "take")}</div>
                <div><b>Seasonal spoils</b> <span className="muted">{d.counts.spoils.items} items, {d.counts.spoils.tradeable} tradeable</span>{rows(d.spoils, "spoilsOut", d, "take")}</div>
                {d.lastRun && <div className="muted" style={{ fontSize: 12 }}>last run: {d.lastRun.summary}</div>}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
