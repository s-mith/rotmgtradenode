import { Fragment, useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";
import { RAID_DUNGEONS } from "@/lib/raidDungeons";
import { SERVERS } from "@/lib/servers";
import { WATCHER_LABEL, type PopView, type WatcherState } from "@/lib/raidRules";

// Operator console for raids (lib/raids.ts, docs/RAIDS.md): every raid with
// nothing hidden (server, bazaar, party, the watcher's state, each pop's
// verdict and who was seen in the bazaar), its audit log on demand, an End /
// Delete per row, the block list, and the fleet's watchers with a form that
// sends one into a bazaar with no raid, to exercise the trip.
//
// End closes a raid the way a leader would (it stays listed as "ended" for
// an hour); Delete removes it and its members outright (the audit stays). A
// blocked name can neither post nor join, and a block covers every name
// linked to the account.

type Raid = {
  id: number;
  dungeonId: string;
  leader: string;
  leaderIgnLower: string;
  region: string;
  server: string;
  location: string;
  party: string;
  description: string;
  keys: number;
  status: "headcount" | "afk" | "popping" | "running" | "ended";
  afkEndsAt: number | null;
  popWindowEndsAt: number | null;
  createdAt: number;
  endedAt: number | null;
  endedBy: string | null;
  limit: number;
  raiders: string[];
  popsDone: number;
  pops: PopView[];
  verdict: string | null;
  verifiable: boolean;
  watcher: { state: WatcherState; note: string; since: number | null };
  watcherBot: string | null;
  bazaarCount: number | null;
  presentCount: number;
  present: string[];
  leaderInRange: boolean | null;
  leaderDistance: number | null;
};
type Ban = { ign: string; ignLower: string; reason: string; createdAt: number };
type Strike = { id: number; ign: string; ignLower: string; kind: string; raidId: number; at: number; active: boolean; clearedAt: number | null };
type Watcher = { key: string; server: string; side: string; state: WatcherState; note: string; bot: string | null; since: number; subscriptions: { raidId: number; portalType: number; until: number }[]; roster: string[]; pops: number };
type Event = { id: number; raidId: number; event: string; ign: string; detail: string; at: number };

const inputStyle: React.CSSProperties = { padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" };
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
const left = (t: number) => `${Math.max(0, Math.ceil((t - Date.now()) / 1000))}s`;
const dungeonName = (id: string) => RAID_DUNGEONS.find((d) => d.id === id)?.dungeon ?? id;

export default function RaidsTab({ password }: { password: string }) {
  const [raids, setRaids] = useState<Raid[] | null>(null);
  const [bans, setBans] = useState<Ban[]>([]);
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [watchersEnabled, setWatchersEnabled] = useState(false);
  const [events, setEvents] = useState<{ raidId: number; rows: Event[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [banIgn, setBanIgn] = useState("");
  const [banReason, setBanReason] = useState("");
  const [watchServer, setWatchServer] = useState<string>(SERVERS[4]);
  const [watchSide, setWatchSide] = useState<"left" | "right">("left");
  const [watchMinutes, setWatchMinutes] = useState("3");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/raids", { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setRaids((data?.raids ?? []) as Raid[]);
      setBans((data?.bans ?? []) as Ban[]);
      setStrikes((data?.strikes ?? []) as Strike[]);
      setWatchers((data?.watchers ?? []) as Watcher[]);
      setWatchersEnabled(Boolean(data?.watchersEnabled));
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [load]);

  async function call(method: "POST" | "DELETE", body: unknown) {
    setBusy(true);
    try {
      const r = await fetch("/api/dev/raids", { method, headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify(body) });
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

  async function showEvents(raidId: number) {
    if (events?.raidId === raidId) {
      setEvents(null);
      return;
    }
    try {
      const r = await fetch(`/api/dev/raids?events=${raidId}`, { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setEvents({ raidId, rows: (data?.events ?? []) as Event[] });
    } catch (e) {
      setError(String(e));
    }
  }

  async function submitBan(e: React.FormEvent) {
    e.preventDefault();
    const ign = banIgn.trim();
    if (!ign) return;
    if (!confirm(`Block ${ign} from raids?\n\nThey can neither post nor join, on any name linked to their account, until the block is lifted.`)) return;
    await call("POST", { op: "ban", ign, reason: banReason.trim() });
    setBanIgn("");
    setBanReason("");
  }

  const popText = (p: PopView) =>
    `#${p.n} ${p.verdict}${p.opener ? ` by ${p.opener}${p.byLeader ? "" : " (not the leader)"}` : ""}${p.entered !== null ? `, ${p.entered} in${p.leaderPoints ? ` (+${p.leaderPoints} pts)` : ""}` : ""}${p.modifiers ? ` [${p.modifiers}]` : ""}`;

  return (
    <section>
      <p style={{ ...muted, fontSize: 13, marginBottom: 12 }}>
        Every raid, with the server, bazaar and party the leader typed (players only see those stage by stage), the watcher's state, each pop's verdict and who was seen in the bazaar. End closes a raid; Delete removes it and its members (the audit stays). Blocks are per name and cover the whole account.
      </p>
      {error && <p style={{ color: "var(--bad, #f66)" }}>{error}</p>}

      <h3 style={{ margin: "8px 0" }}>Raids {raids ? `(${raids.length})` : ""}</h3>
      {raids === null ? (
        <p>Loading…</p>
      ) : raids.length === 0 ? (
        <p style={muted}>No raids on record.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", ...muted }}>
                <th style={{ padding: "6px 8px" }}>Dungeon</th>
                <th style={{ padding: "6px 8px" }}>Leader</th>
                <th style={{ padding: "6px 8px" }}>Stage</th>
                <th style={{ padding: "6px 8px" }}>Server · bazaar</th>
                <th style={{ padding: "6px 8px" }}>Party</th>
                <th style={{ padding: "6px 8px" }}>Watcher</th>
                <th style={{ padding: "6px 8px" }}>Pops</th>
                <th style={{ padding: "6px 8px" }}>Raiders</th>
                <th style={{ padding: "6px 8px" }}>Posted</th>
                <th style={{ padding: "6px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {raids.map((r) => (
                <Fragment key={r.id}>
                  <tr style={{ borderTop: "1px solid var(--border)", opacity: r.status === "ended" ? 0.6 : 1 }}>
                    <td style={{ padding: "6px 8px" }} title={r.description}>
                      <strong>{dungeonName(r.dungeonId)}</strong> · {r.keys} key{r.keys === 1 ? "" : "s"}{r.verifiable ? "" : " (unverifiable)"}
                      {r.description && <div style={{ ...muted, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.description}</div>}
                    </td>
                    <td style={{ padding: "6px 8px" }}><PlayerName ign={r.leader} /></td>
                    <td style={{ padding: "6px 8px" }}>
                      {r.status}
                      {r.status === "afk" && r.afkEndsAt !== null && ` (${left(r.afkEndsAt)})`}
                      {r.status === "popping" && r.popWindowEndsAt !== null && ` (${left(r.popWindowEndsAt)})`}
                      {r.status === "ended" && r.endedBy && <div style={muted}>{r.endedBy.replace("_", " ")}{r.endedAt ? `, ${ago(r.endedAt)}` : ""}</div>}
                    </td>
                    <td style={{ padding: "6px 8px" }}>{r.server} · {r.location}</td>
                    <td style={{ padding: "6px 8px" }}>{r.party || <span style={muted}>none</span>}</td>
                    <td style={{ padding: "6px 8px" }} title={r.watcher.note}>
                      {WATCHER_LABEL[r.watcher.state]}{r.watcherBot ? ` (${r.watcherBot})` : ""}
                      {r.watcher.note && <div style={{ ...muted, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.watcher.note}</div>}
                      {r.bazaarCount !== null && <div style={muted}>{r.bazaarCount} in the bazaar, {r.presentCount} raider(s){r.present.length ? `: ${r.present.join(", ")}` : ""}</div>}
                      {r.leaderInRange !== null && <div style={{ color: r.leaderInRange ? "var(--good)" : "var(--bad, #f66)" }}>leader {r.leaderInRange ? "in" : "out of"} sight{r.leaderDistance !== null ? ` (${r.leaderDistance.toFixed(0)}t)` : ""}</div>}
                    </td>
                    <td style={{ padding: "6px 8px" }}>{r.pops.length ? r.pops.map((p) => <div key={p.n}>{popText(p)}</div>) : <span style={muted}>—</span>}</td>
                    <td style={{ padding: "6px 8px" }} title={r.raiders.join(", ")}>{r.raiders.length} / {r.limit}</td>
                    <td style={{ padding: "6px 8px" }}>{ago(r.createdAt)}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                      <button type="button" style={quietStyle} onClick={() => void showEvents(r.id)}>{events?.raidId === r.id ? "Hide log" : "Log"}</button>{" "}
                      {r.status !== "ended" && (
                        <button type="button" style={quietStyle} disabled={busy} onClick={() => call("POST", { op: "end", id: r.id })}>End</button>
                      )}{" "}
                      <button
                        type="button"
                        style={quietStyle}
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Delete this ${dungeonName(r.dungeonId)} raid by ${r.leader}? Its members go with it.`)) call("POST", { op: "delete", id: r.id });
                        }}
                      >
                        Delete
                      </button>{" "}
                      {!bans.some((b) => b.ignLower === r.leaderIgnLower) && (
                        <button type="button" style={quietStyle} disabled={busy} onClick={() => { setBanIgn(r.leader); setBanReason(""); }} title="Fill the block form with this leader">Block…</button>
                      )}
                    </td>
                  </tr>
                  {events?.raidId === r.id && (
                    <tr>
                      <td colSpan={10} style={{ padding: "6px 8px 12px 24px", fontSize: 12 }}>
                        {events.rows.length === 0 ? (
                          <span style={muted}>no events</span>
                        ) : (
                          events.rows.map((e) => (
                            <div key={e.id}>
                              <span style={muted}>{new Date(e.at).toLocaleTimeString()}</span> <b>{e.event}</b>{e.ign ? ` ${e.ign}` : ""}{e.detail ? ` — ${e.detail}` : ""}
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

      <h3 style={{ margin: "20px 0 8px" }}>Watchers {watchersEnabled ? `(${watchers.length})` : ""}</h3>
      {!watchersEnabled ? (
        <p style={muted}>No fleet watcher is registered: set RAID_WATCHERS=1 with the embedded fleet. Raids run unverified.</p>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void call("POST", { op: "watch", server: watchServer, side: watchSide, minutes: Number(watchMinutes) });
            }}
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}
          >
            <select style={inputStyle} value={watchServer} onChange={(e) => setWatchServer(e.target.value)}>
              {SERVERS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select style={inputStyle} value={watchSide} onChange={(e) => setWatchSide(e.target.value as "left" | "right")}>
              <option value="left">left bazaar</option>
              <option value="right">right bazaar</option>
            </select>
            <input style={{ ...inputStyle, width: 70 }} type="number" min={1} max={30} value={watchMinutes} onChange={(e) => setWatchMinutes(e.target.value)} />
            <span style={muted}>minutes</span>
            <button type="submit" style={buttonStyle} disabled={busy}>Send a watcher</button>
            <span style={{ ...muted, fontSize: 12 }}>A bot logs in there, enters that bazaar and reports the roster and any pop, with no raid involved.</span>
          </form>
          {watchers.length === 0 ? (
            <p style={muted}>No watcher out right now.</p>
          ) : (
            <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", ...muted }}>
                  <th style={{ padding: "6px 8px" }}>Bazaar</th>
                  <th style={{ padding: "6px 8px" }}>State</th>
                  <th style={{ padding: "6px 8px" }}>Bot</th>
                  <th style={{ padding: "6px 8px" }}>Raids</th>
                  <th style={{ padding: "6px 8px" }}>Roster</th>
                  <th style={{ padding: "6px 8px" }}>Pops</th>
                  <th style={{ padding: "6px 8px" }}>Since</th>
                </tr>
              </thead>
              <tbody>
                {watchers.map((w) => (
                  <tr key={w.key} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px" }}>{w.server} · {w.side}</td>
                    <td style={{ padding: "6px 8px" }} title={w.note}>{WATCHER_LABEL[w.state]}{w.note ? <div style={muted}>{w.note}</div> : null}</td>
                    <td style={{ padding: "6px 8px" }}>{w.bot ?? <span style={muted}>—</span>}</td>
                    <td style={{ padding: "6px 8px" }}>{w.subscriptions.length ? w.subscriptions.map((s) => `${s.raidId < 0 ? "manual" : `#${s.raidId}`} (${left(s.until)})`).join(", ") : <span style={muted}>—</span>}</td>
                    <td style={{ padding: "6px 8px" }} title={w.roster.join(", ")}>{w.roster.length}{w.roster.length ? `: ${w.roster.slice(0, 8).join(", ")}${w.roster.length > 8 ? ", …" : ""}` : ""}</td>
                    <td style={{ padding: "6px 8px" }}>{w.pops}</td>
                    <td style={{ padding: "6px 8px" }}>{ago(w.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3 style={{ margin: "20px 0 8px" }}>Strikes {strikes.filter((s) => s.active).length ? `(${strikes.filter((s) => s.active).length} active)` : ""}</h3>
      <p style={{ ...muted, fontSize: 13, marginBottom: 8 }}>A raid that ended with no pop while a watcher stood there, or one cancelled after the AFK check had started. Strikes decay after 30 days: one is an hour off posting, two a day, three a block until cleared here.</p>
      {strikes.length === 0 ? (
        <p style={muted}>No strikes.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {strikes.map((st) => (
              <tr key={st.id} style={{ borderTop: "1px solid var(--border)", opacity: st.active ? 1 : 0.6 }}>
                <td style={{ padding: "6px 8px" }}><PlayerName ign={st.ign} /></td>
                <td style={{ padding: "6px 8px" }}>{st.kind === "no_pop" ? "no pop seen" : "cancelled after the AFK check"} · raid #{st.raidId}</td>
                <td style={{ padding: "6px 8px", ...muted }}>{ago(st.at)}{st.clearedAt ? ", cleared" : st.active ? "" : ", expired"}</td>
                <td style={{ padding: "6px 8px" }}>
                  {st.active && <button type="button" style={quietStyle} disabled={busy} onClick={() => call("POST", { op: "clear_strikes", ign: st.ign })}>Clear all of theirs</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ margin: "20px 0 8px" }}>Blocked from raids {bans.length ? `(${bans.length})` : ""}</h3>
      <form onSubmit={submitBan} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input style={inputStyle} placeholder="IGN" value={banIgn} onChange={(e) => setBanIgn(e.target.value)} />
        <input style={{ ...inputStyle, flex: "1 1 240px" }} placeholder="Reason (optional)" value={banReason} onChange={(e) => setBanReason(e.target.value)} />
        <button type="submit" style={buttonStyle} disabled={busy || !banIgn.trim()}>Block</button>
      </form>
      {bans.length === 0 ? (
        <p style={muted}>Nobody is blocked.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {bans.map((b) => (
              <tr key={b.ignLower} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 8px" }}><PlayerName ign={b.ign} /></td>
                <td style={{ padding: "6px 8px", ...muted }}>{b.reason || "no reason given"}</td>
                <td style={{ padding: "6px 8px", ...muted }}>{ago(b.createdAt)}</td>
                <td style={{ padding: "6px 8px" }}>
                  <button type="button" style={quietStyle} disabled={busy} onClick={() => call("DELETE", { ign: b.ign })}>Unblock</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
