import { Fragment, useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";
import { RAID_DUNGEONS } from "@/lib/raidDungeons";
import { CALL_OUTCOME_LABEL, HUNTER_LABEL, type HuntCallView, type HunterReport, type HuntView } from "@/lib/realmhuntRules";

// Operator console for realm hunts (lib/realmhunts.ts, docs/REALMHUNTS.md):
// every hunt (open, and ended within the hour) with its server, party, the
// hunter's state, its members and every call with what was counted, its
// audit log on demand, and the fleet's hunters. A hunt closes on its own;
// End here is the only way a person closes one. Delete removes it and its
// calls outright (the audit stays).

type Event = { id: number; huntId: number; event: string; ignLower: string; detail: string; at: number };

const buttonStyle: React.CSSProperties = { padding: "6px 12px", background: "var(--accent)", border: 0, borderRadius: 6, color: "#000", fontWeight: 600, cursor: "pointer" };
const quietStyle: React.CSSProperties = { ...buttonStyle, background: "transparent", color: "var(--text)", border: "1px solid var(--border)" };
const muted: React.CSSProperties = { color: "var(--muted, #999)" };

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const dungeonName = (id: string) => RAID_DUNGEONS.find((d) => d.id === id)?.dungeon ?? id;
const callText = (c: HuntCallView) =>
  `${c.caller}: ${c.outcome === null ? "in progress" : c.outcome === "counted" || c.outcome === "other_dungeon" ? `${c.entered} in (${c.partyEntered} party)${c.finderPoints ? ` +${c.finderPoints}` : ""}${c.outcome === "other_dungeon" ? ", not the hunted dungeon" : ""}` : CALL_OUTCOME_LABEL[c.outcome]}${c.note ? ` — ${c.note}` : ""}`;

export default function RealmhuntsTab({ password }: { password: string }) {
  const [hunts, setHunts] = useState<HuntView[] | null>(null);
  const [hunters, setHunters] = useState<HunterReport[]>([]);
  const [huntersEnabled, setHuntersEnabled] = useState(false);
  const [events, setEvents] = useState<{ huntId: number; rows: Event[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/realmhunts", { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setHunts((data?.hunts ?? []) as HuntView[]);
      setHunters((data?.hunters ?? []) as HunterReport[]);
      setHuntersEnabled(Boolean(data?.huntersEnabled));
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [load]);

  async function call(body: unknown) {
    setBusy(true);
    try {
      const r = await fetch("/api/dev/realmhunts", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function showEvents(huntId: number) {
    if (events?.huntId === huntId) {
      setEvents(null);
      return;
    }
    try {
      const r = await fetch(`/api/dev/realmhunts?events=${huntId}`, { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setEvents({ huntId, rows: (data?.events ?? []) as Event[] });
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section>
      <p style={{ ...muted, fontSize: 13, marginBottom: 12 }}>
        Every realm hunt with its server, party, the hunter's state, the party's members and each call the hunter answered (who called, how many it counted, the finder's points). A hunt closes on its own — 20 minutes without a counted call, the ceiling, a failed hunter — and nobody but an operator can close one: End does that (the hunter leaves the party). Delete removes it and its calls; the audit stays.
      </p>
      {error && <p style={{ color: "var(--bad, #f66)" }}>{error}</p>}

      <h3 style={{ margin: "8px 0" }}>Hunts {hunts ? `(${hunts.length})` : ""}</h3>
      {hunts === null ? (
        <p>Loading…</p>
      ) : hunts.length === 0 ? (
        <p style={muted}>No hunts on record.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", ...muted }}>
                <th style={{ padding: "6px 8px" }}>Dungeon</th>
                <th style={{ padding: "6px 8px" }}>Requester</th>
                <th style={{ padding: "6px 8px" }}>Status</th>
                <th style={{ padding: "6px 8px" }}>Server · party</th>
                <th style={{ padding: "6px 8px" }}>Hunter</th>
                <th style={{ padding: "6px 8px" }}>Members</th>
                <th style={{ padding: "6px 8px" }}>Calls</th>
                <th style={{ padding: "6px 8px" }}>Posted</th>
                <th style={{ padding: "6px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {hunts.map((h) => (
                <Fragment key={h.id}>
                  <tr style={{ borderTop: "1px solid var(--border)", opacity: h.status === "ended" ? 0.6 : 1 }}>
                    <td style={{ padding: "6px 8px" }}><strong>{dungeonName(h.dungeonId)}</strong> · {h.region} · party of {h.limit}</td>
                    <td style={{ padding: "6px 8px" }}><PlayerName ign={h.requester} /></td>
                    <td style={{ padding: "6px 8px" }}>
                      {h.status}
                      {h.status === "ended" && h.endedBy && <div style={muted}>{h.endedBy}{h.endedAt ? `, ${ago(h.endedAt)}` : ""}</div>}
                    </td>
                    <td style={{ padding: "6px 8px" }}>{h.server} · {h.partyName}{h.partyId ? <span style={muted}> (#{h.partyId})</span> : ""}</td>
                    <td style={{ padding: "6px 8px" }} title={h.hunter.note}>
                      {HUNTER_LABEL[h.hunter.state]}{h.hunter.bot ? ` (${h.hunter.bot})` : ""}
                      {h.hunter.note && <div style={{ ...muted, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.hunter.note}</div>}
                    </td>
                    <td style={{ padding: "6px 8px" }} title={h.members.join(", ")}>{h.members.length}{h.members.length ? `: ${h.members.slice(0, 6).join(", ")}${h.members.length > 6 ? "…" : ""}` : ""}</td>
                    <td style={{ padding: "6px 8px" }}>{h.calls.length ? h.calls.slice(-5).map((c) => <div key={c.id}>{callText(c)}</div>) : <span style={muted}>—</span>}</td>
                    <td style={{ padding: "6px 8px" }}>{ago(h.createdAt)}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                      <button type="button" style={quietStyle} onClick={() => void showEvents(h.id)}>{events?.huntId === h.id ? "Hide log" : "Log"}</button>{" "}
                      {h.status !== "ended" && (
                        <button type="button" style={quietStyle} disabled={busy} onClick={() => { if (confirm(`End ${h.requester}'s ${dungeonName(h.dungeonId)} hunt? The hunter leaves the party.`)) call({ op: "end", id: h.id }); }}>End</button>
                      )}{" "}
                      <button type="button" style={quietStyle} disabled={busy} onClick={() => { if (confirm(`Delete this ${dungeonName(h.dungeonId)} hunt by ${h.requester}? Its calls go with it.`)) call({ op: "delete", id: h.id }); }}>Delete</button>
                    </td>
                  </tr>
                  {events?.huntId === h.id && (
                    <tr>
                      <td colSpan={9} style={{ padding: "6px 8px 12px 24px", fontSize: 12 }}>
                        {events.rows.length === 0 ? (
                          <span style={muted}>no events</span>
                        ) : (
                          events.rows.map((e) => (
                            <div key={e.id}>
                              <span style={muted}>{new Date(e.at).toLocaleTimeString()}</span> <b>{e.event}</b>{e.ignLower ? ` ${e.ignLower}` : ""}{e.detail ? ` — ${e.detail}` : ""}
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ margin: "20px 0 8px" }}>Hunters {huntersEnabled ? `(${hunters.length})` : ""}</h3>
      {!huntersEnabled ? (
        <p style={muted}>No fleet hunter is registered: set REALM_HUNTS=1 with the embedded fleet. Hunts are posted without a bot.</p>
      ) : hunters.length === 0 ? (
        <p style={muted}>No hunter out right now.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", ...muted }}>
              <th style={{ padding: "6px 8px" }}>Hunt</th>
              <th style={{ padding: "6px 8px" }}>Server</th>
              <th style={{ padding: "6px 8px" }}>State</th>
              <th style={{ padding: "6px 8px" }}>Bot</th>
              <th style={{ padding: "6px 8px" }}>Party</th>
              <th style={{ padding: "6px 8px" }}>Calls</th>
              <th style={{ padding: "6px 8px" }}>Since</th>
            </tr>
          </thead>
          <tbody>
            {hunters.map((w) => (
              <tr key={w.huntId} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 8px" }}>#{w.huntId}</td>
                <td style={{ padding: "6px 8px" }}>{w.server}</td>
                <td style={{ padding: "6px 8px" }} title={w.note}>{HUNTER_LABEL[w.state]}{w.note ? <div style={{ ...muted, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.note}</div> : null}</td>
                <td style={{ padding: "6px 8px" }}>{w.bot ?? <span style={muted}>—</span>}</td>
                <td style={{ padding: "6px 8px" }} title={w.members.join(", ")}>{w.partyId ? `#${w.partyId}, ${w.members.length} in` : <span style={muted}>none yet</span>}</td>
                <td style={{ padding: "6px 8px" }}>{w.calls}</td>
                <td style={{ padding: "6px 8px" }}>{ago(w.since)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
