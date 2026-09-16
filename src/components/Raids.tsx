"use client";

// Raids: a dungeon raiding group finder and creator, after the Discord raid
// bots (headcount → AFK check → pop → run), for every standard key in the
// game, with the pop proved by a fleet bot in the bazaar (docs/RAIDS.md).
//
// The list comes from /api/raids and is refetched on the live stream's
// "raids" events; every secret (server, bazaar, party) arrives from the
// server only once this viewer may have it, so the reveal logic here is
// presentation over fields that are null until then (lib/raids.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CopyText from "./CopyText";
import { RAID_DUNGEONS, type RaidDungeon } from "@/lib/raidDungeons";
import { SERVERS, WITHDRAW_SERVERS } from "@/lib/servers";
import { serverOffLabel, useServerControls } from "@/lib/useServerControls";
import { AFK_SECONDS, LEADER_RANGE_TILES, LOCATIONS, MAX_DESCRIPTION, MAX_KEYS, MAX_PARTY, POP_EXTEND_S, POP_WINDOW_S, RAIDER_POINTS_ENTERED, regionOf, WATCHER_LABEL, type Location, type PopView, type RaidStatus, type RaidView } from "@/lib/raidRules";

export type Raid = RaidView;
export const STATUS_LABEL: Record<RaidStatus, string> = { headcount: "Headcount", afk: "AFK check", popping: "Pop", running: "Running", ended: "Ended" };
const ENDED_BY_LABEL = { leader: "ended by the leader", leader_left: "the leader left", timeout: "timed out", operator: "closed by an operator", no_pop: "no pop was seen" } as const;

type Limits = { description: number; party: number; keys: number; afkSeconds: number; popWindowSeconds: number; popExtendSeconds: number };
const DEFAULT_LIMITS: Limits = { description: MAX_DESCRIPTION, party: MAX_PARTY, keys: MAX_KEYS, afkSeconds: AFK_SECONDS, popWindowSeconds: POP_WINDOW_S, popExtendSeconds: POP_EXTEND_S };

const NOTIFY_KEY = "raids_notify";
function notifyPref(): boolean {
  try {
    return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

export function dungeonFor(id: string): RaidDungeon {
  return RAID_DUNGEONS.find((d) => d.id === id) ?? RAID_DUNGEONS[0];
}
function ago(t: number, now: number): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}
function countdown(endsAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const minutes = (s: number): string => (s % 60 === 0 ? `${s / 60} min` : `${s}s`);

/** The latest confirmed pop, for the card's badge. */
function lastConfirmed(r: Raid): PopView | null {
  for (let i = r.pops.length - 1; i >= 0; i--) if (r.pops[i].verdict === "confirmed") return r.pops[i];
  return null;
}

/**
 * The raid list and the actions on it. `me` is the session IGN (null when
 * logged out); `active` says the Raids tab is showing, so a live event
 * refetches at once rather than only when this viewer is in an open raid.
 */
export function useRaids(me: string | null, active: boolean) {
  const [raids, setRaids] = useState<Raid[]>([]);
  const [banned, setBanned] = useState(false);
  const [hold, setHold] = useState<{ strikes: number; until: number | null } | null>(null);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [watchers, setWatchers] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notify, setNotifyState] = useState(false);
  useEffect(() => setNotifyState(notifyPref()), []);

  // The list as of the last fetch, for spotting the stage changes worth a
  // notification (only for raids this viewer is in).
  const seen = useRef<Map<number, Raid> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/raids", { cache: "no-store" });
      const d = (await r.json()) as { raids?: Raid[]; me?: { ign: string; banned: boolean; hold?: { strikes: number; until: number | null } } | null; limits?: Limits; watchers?: boolean; error?: string };
      if (!r.ok || !d.raids) throw new Error(d.error || `HTTP ${r.status}`);
      if (seen.current && notifyPref()) announce(seen.current, d.raids);
      seen.current = new Map(d.raids.map((x) => [x.id, x]));
      setRaids(d.raids);
      setBanned(Boolean(d.me?.banned));
      // JSON has no Infinity: a block arrives as null `until` with the strikes at the block line, which the creator reads as blocked.
      setHold(d.me?.hold ?? null);
      if (d.limits) setLimits(d.limits);
      setWatchers(Boolean(d.watchers));
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // First load, and again whenever the login changes: the same list reads
  // differently to a different viewer.
  useEffect(() => {
    void refresh();
  }, [refresh, me]);

  // A live "raids" event: refetch. The list is small and the events are
  // rare (a few per raid), and the Raids tab's headcount badge shows from
  // every tab, so the count has to stay right when the tab is not showing.
  const onLive = useCallback(() => {
    void refresh();
  }, [refresh]);

  async function post(url: string, body: unknown): Promise<boolean> {
    setError(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json()) as { error?: string; raid?: Raid };
      if (!r.ok) {
        setError(d.error || `HTTP ${r.status}`);
        return false;
      }
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  return {
    raids, banned, hold, limits, watchers, loaded, error, setError, selectedId, setSelectedId, refresh, onLive, notify,
    async create(input: { dungeonId: string; server: string; location: Location; party: string; description: string; keys: number }): Promise<number | null> {
      setError(null);
      try {
        const r = await fetch("/api/raids", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
        const d = (await r.json()) as { error?: string; raid?: Raid };
        if (!r.ok || !d.raid) {
          setError(d.error || `HTTP ${r.status}`);
          return null;
        }
        await refresh();
        setSelectedId(d.raid.id);
        return d.raid.id;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    act(id: number, action: "join" | "leave" | "advance" | "end" | "next" | "extend" | "call") {
      return post(`/api/raids/${id}`, { action });
    },
    async setNotify(on: boolean) {
      if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") return;
      }
      try {
        localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
      } catch {
        // Storage blocked: the switch just doesn't survive a reload.
      }
      setNotifyState(on && typeof Notification !== "undefined" && Notification.permission === "granted");
    },
  };
}
export type RaidsState = ReturnType<typeof useRaids>;

/** Browser notifications for the stage changes of raids this viewer is in. */
function announce(before: Map<number, Raid>, after: Raid[]): void {
  for (const r of after) {
    const p = before.get(r.id);
    if (!p || !r.joined) continue;
    const d = dungeonFor(r.dungeonId);
    let body: string | null = null;
    if (p.status !== r.status) {
      if (r.leading) {
        if (r.status === "popping") body = r.watcher.state === "in_bazaar" ? "The AFK check is over and the watcher is in place: pop your key now." : "The AFK check is over: pop your key when the watcher is in place.";
        else if (r.status === "ended" && r.endedBy === "no_pop") body = "The raid ended: no pop was seen in the bazaar.";
      } else if (r.status === "afk") body = r.location ? `AFK check is open. Popping at the ${r.location} on ${r.server}.` : "AFK check is open — join it to get the location.";
      else if (r.status === "popping") body = `The AFK check is over: be in the ${r.location ?? "bazaar"}.${r.party ? ` Party: ${r.party}.` : ""}`;
      else if (r.status === "ended") body = `The raid ended (${ENDED_BY_LABEL[r.endedBy ?? "leader"]}).`;
    }
    const wasPopped = lastConfirmed(p);
    const nowPopped = lastConfirmed(r);
    if (nowPopped && (!wasPopped || wasPopped.n !== nowPopped.n) && !r.leading) body = `Popped${nowPopped.opener ? ` by ${nowPopped.opener}` : ""} — enter the portal now!`;
    if (!body) continue;
    try {
      new Notification(`${d.dungeon} — ${r.leader}`, { body, tag: `raid-${r.id}`, icon: d.keyImg });
    } catch {
      // Notifications unsupported here (some mobile browsers): nothing to do.
    }
  }
}

/** The leader's standing on the card: pops of their own out of raids led, and any active strikes. */
function LeaderRecordTag({ rec }: { rec: Raid["leaderRecord"] }) {
  const title = `${rec.led} raid${rec.led === 1 ? "" : "s"} led · ${rec.popped} popped by them${rec.poppedByOthers ? ` · ${rec.poppedByOthers} popped by someone else` : ""}${rec.strikes ? ` · ${rec.strikes} strike${rec.strikes === 1 ? "" : "s"} in the last 30 days (a raid ended with no pop, or cancelled after the AFK check)` : ""}`;
  return (
    <span className="raid-record" title={title}>
      {rec.popped > 0 ? <span className="raid-record-ok">{rec.popped}/{rec.led} popped</span> : rec.led > 0 ? <span className="raid-record-new">no verified pops yet</span> : <span className="raid-record-new">new leader</span>}
      {rec.strikes > 0 && <span className="raid-record-bad">{rec.strikes} strike{rec.strikes === 1 ? "" : "s"}</span>}
    </span>
  );
}

/** A clock that ticks every second while a countdown is showing, else every 30s. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

// ---------------------------------------------------------------------------
// Finder (left column): every open raid, filterable. Clicking a card expands
// it in place (location, raiders, the watcher, leader controls); clicking
// again folds it.

export function RaidFinder({ state, me }: { state: RaidsState; me: string | null }) {
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("");
  const [status, setStatus] = useState<"open" | RaidStatus | "all">("open");
  const [mine, setMine] = useState(false);
  const { raids, selectedId, setSelectedId } = state;
  const now = useNow(raids.some((r) => r.status === "afk" || r.status === "popping"));
  const regions = useMemo(() => [...new Set(SERVERS.map(regionOf))], []);

  // A countdown that has just run out: refetch now rather than wait for the
  // server's next sweep (the GET applies the transition inline). Once per
  // deadline: the refetch changes the stage and with it the deadline.
  const refreshedFor = useRef<number | null>(null);
  useEffect(() => {
    const due = raids
      .map((r) => r.afkEndsAt ?? r.popWindowEndsAt ?? null)
      .filter((t): t is number => t !== null && t <= now)
      .sort((a, b) => a - b)[0];
    if (due === undefined || refreshedFor.current === due) return;
    refreshedFor.current = due;
    void state.refresh();
  }, [now, raids, state]);

  const shown = raids.filter((r) => {
    const d = dungeonFor(r.dungeonId);
    if (query && !`${d.dungeon} ${d.key} ${r.leader}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (region && r.region !== region) return false;
    if (status === "open" ? r.status === "ended" : status !== "all" && r.status !== status) return false;
    if (mine && !r.joined) return false;
    return true;
  });

  return (
    <div className="raids">
      <div className="pool-controls raids-controls">
        <input type="search" className="pool-search" placeholder="Search dungeon or leader…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {/* Regions, not servers: the exact server stays hidden until the AFK check. */}
        <select className="raids-select" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region">
          <option value="">Any region</option>
          {regions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="raids-chips" role="group" aria-label="Status">
        {(["open", "headcount", "afk", "popping", "running", "ended", "all"] as const).map((s) => (
          <button key={s} type="button" className={"login-char-btn" + (status === s ? " wish-pool-active" : "")} aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === "open" ? "Open" : s === "all" ? "All" : STATUS_LABEL[s]}
          </button>
        ))}
        <span className="raids-chips-right">
          {me && typeof Notification !== "undefined" && (
            <button type="button" className={"login-char-btn" + (state.notify ? " wish-pool-active" : "")} aria-pressed={state.notify} title="A browser notification when a raid you joined opens its AFK check, is popped, or ends" onClick={() => void state.setNotify(!state.notify)}>
              {state.notify ? "Notifying" : "Notify me"}
            </button>
          )}
          <button type="button" className={"login-char-btn" + (mine ? " wish-pool-active" : "")} aria-pressed={mine} onClick={() => setMine((m) => !m)}>Joined</button>
        </span>
      </div>
      {state.error && <p className="login-err raids-err">{state.error}</p>}

      <ul className="raid-list">
        {!state.loaded && <li className="hint">Loading raids…</li>}
        {state.loaded && shown.length === 0 && <li className="hint">{raids.length === 0 ? "No raids right now. Post one on the right." : "No raids match."}</li>}
        {shown.map((r) => {
          const d = dungeonFor(r.dungeonId);
          const open = r.id === selectedId;
          const popped = lastConfirmed(r);
          return (
            <li key={r.id} className={"raid-card" + (open ? " active" : "") + (r.status === "ended" ? " ended" : "")} onClick={() => setSelectedId(open ? null : r.id)}>
              <div className="raid-portal">
                {d.portalImg ? <img src={d.portalImg} alt="" width={48} height={48} /> : <img src={d.keyImg} alt="" width={40} height={40} />}
              </div>
              <div className="raid-main">
                <div className="raid-title">
                  <img src={d.keyImg} alt="" width={20} height={20} className="raid-key-icon" />
                  <strong>{d.dungeon}</strong>
                  <span className={"raid-status raid-status-" + r.status}>
                    {STATUS_LABEL[r.status]}
                    {r.status === "afk" && r.afkEndsAt !== null && <span className="raid-afk-timer">{countdown(r.afkEndsAt, now)}</span>}
                    {r.status === "popping" && r.popWindowEndsAt !== null && <span className="raid-afk-timer">{countdown(r.popWindowEndsAt, now)}</span>}
                  </span>
                  {popped && <span className="raid-verdict raid-verdict-confirmed" title={popped.modifiers ? `modifiers ${popped.modifiers}` : undefined}>popped{r.popsDone > 1 ? ` ×${r.popsDone}` : ""} ✓{popped.opener ? ` by ${popped.opener}${popped.byLeader ? "" : " (not the leader)"}` : ""}</span>}
                  {!popped && r.verdict === "none" && <span className="raid-verdict raid-verdict-none">no pop seen</span>}
                  {!popped && r.verdict === "other" && <span className="raid-verdict raid-verdict-other">popped by someone else</span>}
                  {!popped && r.verdict === "unverified" && <span className="raid-verdict">unverified</span>}
                  {r.leading && <span className="raid-you">You lead</span>}
                  {r.joined && !r.leading && r.status !== "ended" && <span className="raid-you">Joined</span>}
                </div>
                <div className="raid-meta">
                  <span><b>{r.leader}</b> <span className="raid-rl">RL</span> <LeaderRecordTag rec={r.leaderRecord} /></span>
                  {r.server && r.location
                    ? <span className="raid-loc"><b>{r.server}</b> · <b>{r.location}</b></span>
                    : <span className="raid-loc raid-loc-hidden" title="Server and bazaar are revealed to raiders as they join the AFK check">{r.region} · location hidden</span>}
                  {r.party && <span className="raid-loc">party <CopyText text={r.party} title="Copy the party name" /></span>}
                  <span>{ago(r.createdAt, now)}</span>
                </div>
                {r.description && <p className="raid-desc">{r.description}</p>}
                <div className="raid-reacts">
                  <span className="raid-count">{r.raiders.length} / {r.limit} raiders</span>
                  <span className="raid-react">{r.keys} key{r.keys === 1 ? "" : "s"}{r.popsDone ? `, ${r.popsDone} popped` : ""}</span>
                  {r.status !== "headcount" && r.status !== "ended" && r.watcher.state !== "none" && (
                    <span className={"raid-react" + (r.watcher.state === "in_bazaar" ? " ok" : "")} title={r.watcher.note || undefined}>{WATCHER_LABEL[r.watcher.state]}</span>
                  )}
                  {r.bazaarCount !== null && r.status !== "ended" && <span className="raid-count">{r.presentCount} of {r.raiders.length} raiders seen there</span>}
                  {r.joined && !r.leading && r.presentMe && r.status !== "ended" && <span className="raid-react ok">we see you in the bazaar ✓</span>}
                </div>
              </div>
              <div className="raid-actions" onClick={(e) => e.stopPropagation()}>
                {r.status !== "ended" && !r.leading && (
                  <button
                    type="button"
                    className={"raid-btn" + (r.joined ? " raid-btn-quiet" : "")}
                    disabled={!r.joined && r.raiders.length >= r.limit}
                    title={!me ? "Log in to join" : !r.joined && r.raiders.length >= r.limit ? "This raid is full" : undefined}
                    onClick={() => {
                      if (!me) {
                        state.setError("Log in with your character to join a raid.");
                        return;
                      }
                      void state.act(r.id, r.joined ? "leave" : "join");
                    }}
                  >
                    {r.joined ? "Leave" : "Join"}
                  </button>
                )}
              </div>
              {/* Always mounted so folding animates too; the wrapper's row grows 0fr -> 1fr. */}
              <div className="raid-expand" aria-hidden={!open} onClick={(e) => e.stopPropagation()}>
                <div className="raid-expand-inner">
                  <RaidDetail raid={r} state={state} open={open} now={now} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RaidDetail({ raid: r, state, open, now }: { raid: Raid; state: RaidsState; open: boolean; now: number }) {
  const [busy, setBusy] = useState(false);
  // Folded panes keep their controls out of the tab order.
  const tab = open ? undefined : -1;
  async function run(action: "advance" | "end" | "next" | "extend" | "call") {
    setBusy(true);
    try {
      await state.act(r.id, action);
    } finally {
      setBusy(false);
    }
  }
  const w = r.watcher;
  const watcherLine = (() => {
    if (!r.verifiable) return { text: "This key's portal is not known to the site, so no watcher can confirm the pop.", ok: false, bad: false };
    if (r.status === "headcount") return { text: w.state === "none" ? (state.watchers ? "A watcher bot goes to the bazaar when the AFK check starts, to confirm the pop." : "No watcher bot is available: this raid will run unverified.") : `${WATCHER_LABEL[w.state]}${w.note ? ` — ${w.note}` : ""}`, ok: w.state === "in_bazaar", bad: w.state === "failed" };
    if (r.status === "ended") return null;
    if (w.state === "none") return { text: `No watcher: ${w.note || "none was available"}. The pop cannot be confirmed.`, ok: false, bad: true };
    return { text: `${WATCHER_LABEL[w.state]}${w.note ? ` — ${w.note}` : ""}${r.bazaarCount !== null ? `; ${r.bazaarCount} player${r.bazaarCount === 1 ? "" : "s"} in the bazaar` : ""}`, ok: w.state === "in_bazaar", bad: w.state === "failed" };
  })();
  return (
    <section className="raid-detail">
      <p className={"raid-loc-line" + (r.server && r.location ? " revealed" : "")}>
        {r.server && r.location
          ? r.leading
            ? <>Popping at the <b>{r.location}</b> on <b>{r.server}</b>. Raiders see this once they join the AFK check.</>
            : <>Popping at the <b>{r.location}</b> on <b>{r.server}</b>. Head there now.</>
          : r.status === "headcount"
            ? `${r.region} server. The exact server and bazaar come with the AFK check; joining now just counts you in.`
            : r.status === "ended"
              ? `This raid is over (${ENDED_BY_LABEL[r.endedBy ?? "leader"]}).`
              : `${r.region} server. Join the AFK check and the server and bazaar are revealed to you.`}
      </p>
      {r.hasParty && r.status !== "ended" && (
        <p className={"raid-loc-line" + (r.party ? " revealed" : "")}>
          {r.party
            ? r.leading
              ? <>Party <CopyText text={r.party} title="Copy the party name" />. Raiders get it once the AFK check is complete.</>
              : <>Party <CopyText text={r.party} title="Copy the party name" />. Join it in game to get pulled in with the group.</>
            : r.joined && r.status === "afk"
              ? "The party name follows once the AFK check ends."
              : "Raiders get the party name once the AFK check ends."}
        </p>
      )}
      {watcherLine && (
        <p className="raid-watch">
          <span className={watcherLine.ok ? "ok" : watcherLine.bad ? "bad" : undefined}>{watcherLine.text}</span>
        </p>
      )}
      {r.leading && w.state === "in_bazaar" && r.status !== "ended" && (
        <p className="raid-watch">
          {r.leaderInRange === null
            ? <span>The watcher has not seen you yet: it stands at the bazaar entrance and can only see a pop within {LEADER_RANGE_TILES} tiles of it.</span>
            : r.leaderInRange
              ? <span className="ok">The watcher can see you{r.leaderDistance !== null ? ` (${r.leaderDistance.toFixed(0)} tiles)` : ""}: a pop here counts.</span>
              : <span className="bad">You are out of the watcher's sight{r.leaderDistance !== null ? ` (${r.leaderDistance.toFixed(0)} tiles)` : ""}: come within {LEADER_RANGE_TILES} tiles of it at the bazaar entrance or your pop will not count. It whispers you in game when this changes.</span>}
        </p>
      )}
      {r.leading && r.status === "popping" && (
        <p className={"raid-pop-now" + (w.state === "in_bazaar" && r.leaderInRange !== false ? "" : " wait")}>
          {w.state === "in_bazaar"
            ? r.leaderInRange === false
              ? `The watcher is in the ${r.location ?? "bazaar"} but cannot see you — get closer to it first (${countdown(r.popWindowEndsAt ?? now, now)} left).`
              : `The watcher is in the ${r.location ?? "bazaar"} — pop your key now (${countdown(r.popWindowEndsAt ?? now, now)} left).`
            : w.state === "none" || w.state === "failed"
              ? `Pop when you are ready (${countdown(r.popWindowEndsAt ?? now, now)} left); this pop will go unverified.`
              : `${WATCHER_LABEL[w.state]}${w.note ? ` (${w.note})` : ""} — hold your key a moment if you can (${countdown(r.popWindowEndsAt ?? now, now)} left).`}
        </p>
      )}
      {r.pops.length > 0 && (
        <ul className="raid-pops">
          {r.pops.map((p) => (
            <li key={p.n}>
              <b>Pop {p.n}</b>{" "}
              {p.verdict === "confirmed"
                ? <>confirmed ✓{p.opener ? ` by ${p.opener}${p.byLeader ? "" : " (not the leader)"}` : ""}{p.poppedAt ? `, ${ago(p.poppedAt, now)}` : ""}{p.entered !== null ? `, ${p.entered} raider${p.entered === 1 ? "" : "s"} went in${p.leaderPoints ? ` · leader +${p.leaderPoints} pts, each raider +${RAIDER_POINTS_ENTERED}` : ""}` : p.closedAt === null && p.poppedAt ? ", portal open" : ""}{p.modifiers ? ` · mods ${p.modifiers}` : ""}</>
                : p.verdict === "pending"
                  ? `waiting for the pop${p.windowEndsAt ? ` (${countdown(p.windowEndsAt, now)} left)` : ""}`
                  : p.verdict === "none"
                    ? "no pop was seen in the bazaar"
                    : p.verdict === "other"
                      ? `a portal opened there, but by ${p.opener ?? "someone else"}`
                      : "unverified: no watcher could look"}
            </li>
          ))}
        </ul>
      )}
      <h4>Raiders <span className="raid-count">{r.raiders.length} / {r.limit}</span></h4>
      <div className="raid-names">
        {r.raiders.map((n, i) => {
          const here = r.present?.some((p) => p.toLowerCase() === n.toLowerCase());
          return <span key={n + i} className={"raid-name" + (n === r.leader ? " leader" : "")} title={here ? "seen in the bazaar" : undefined}>{n}{here ? " ✓" : ""}</span>;
        })}
      </div>
      {r.leading && r.bazaarCount !== null && r.status !== "ended" && (
        <p className="raid-present">{r.presentCount} of {r.raiders.length} raiders seen in the bazaar{r.present?.length ? `: ${r.present.join(", ")}` : ""}.</p>
      )}
      {r.leading && r.status !== "ended" && (
        <div className="raid-detail-actions">
          {r.status === "headcount" && (
            <>
              <button type="button" tabIndex={tab} className="raid-btn" disabled={busy} onClick={() => void run("advance")}>Start AFK check ({minutes(state.limits.afkSeconds)})</button>
              {r.verifiable && state.watchers && (w.state === "none" || w.state === "left" || w.state === "failed") && (
                <button type="button" tabIndex={tab} className="raid-btn raid-btn-quiet" disabled={busy} title="Get the watcher bot into the bazaar before the AFK check (a server with a login queue)" onClick={() => void run("call")}>Call the watcher now</button>
              )}
            </>
          )}
          {r.status === "afk" && (
            <button type="button" tabIndex={tab} className="raid-btn" disabled={busy} title="Close the AFK check now; the pop window opens" onClick={() => void run("advance")}>
              Close the AFK check now{r.afkEndsAt !== null ? ` (${countdown(r.afkEndsAt, now)} left)` : ""}
            </button>
          )}
          {r.status === "popping" && r.extended < 1 && (
            <button type="button" tabIndex={tab} className="raid-btn raid-btn-quiet" disabled={busy} onClick={() => void run("extend")}>Extend the window +{minutes(state.limits.popExtendSeconds)}</button>
          )}
          {r.status === "running" && r.keysLeft > 0 && (
            <button type="button" tabIndex={tab} className="raid-btn" disabled={busy} title="Back in the bazaar with the next key: a watcher is sent to record the next pop" onClick={() => void run("next")}>
              Next pop ({r.keysLeft} key{r.keysLeft === 1 ? "" : "s"} left)
            </button>
          )}
          {r.status === "running" && (
            <button type="button" tabIndex={tab} className={"raid-btn" + (r.keysLeft > 0 ? " raid-btn-quiet" : "")} disabled={busy} onClick={() => void run("advance")}>End run</button>
          )}
          {r.status !== "running" && (
            <button type="button" tabIndex={tab} className="raid-btn raid-btn-quiet" disabled={busy} onClick={() => void run("end")}>Cancel raid</button>
          )}
          <span className="hint">
            {r.status === "headcount"
              ? `The AFK check lasts ${minutes(state.limits.afkSeconds)} and reveals the server and bazaar to everyone who joins it; then you have ${minutes(state.limits.popWindowSeconds)} to pop. Cancelling is free until then; after that it is a strike, as is a window with no pop.`
              : r.status === "afk"
                ? "When the check ends the party name goes out and the pop window opens."
                : r.status === "popping"
                  ? "Pop where you announced; the watcher confirms it and the raid moves to running."
                  : `Runs end by themselves after 90 minutes.${r.keysLeft > 0 ? " With another key, go back to the bazaar and press Next pop." : ""}`}
          </span>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Creator (right column): pick any key in the game, say where, and post.

export function RaidCreator({ state, me }: { state: RaidsState; me: string | null }) {
  const [query, setQuery] = useState("");
  const [dungeonId, setDungeonId] = useState<string>("lost-halls-key");
  const [server, setServer] = useState<string>(SERVERS[4]);
  const [location, setLocation] = useState<Location>("Left bazaar");
  const [party, setParty] = useState("");
  const [description, setDescription] = useState("");
  const [keys, setKeys] = useState(1);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);

  const picks = useMemo(() => RAID_DUNGEONS.filter((d) => !query || `${d.dungeon} ${d.key}`.toLowerCase().includes(query.toLowerCase())), [query]);
  const chosen = dungeonFor(dungeonId);
  const leading = state.raids.find((r) => r.leading && r.status !== "ended") ?? null;
  // The same server rules as a withdraw: the operator's per-server switch and Realm's load reading (a server
  // 75% or 100% full is out). Same list, same flag and same labels as the withdraw picker.
  const controls = useServerControls();
  const busy = (s: string) => Boolean(controls[s]?.withdraws);
  // A server that closes under the leader's choice is dropped, like the withdraw picker does.
  useEffect(() => {
    if (busy(server)) setServer(WITHDRAW_SERVERS.find((s) => !busy(s)) ?? server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls]);
  const hold = state.hold;
  const held = !!hold && (hold.until !== null || hold.strikes >= 3);
  const holdText = !hold || !held ? "" : hold.until === null || hold.strikes >= 3
    ? `Posting is blocked: ${hold.strikes} strikes. An operator can clear them.`
    : `Posting is on cooldown for ${Math.max(1, Math.ceil((hold.until - Date.now()) / 60_000))} min after ${hold.strikes} strike${hold.strikes === 1 ? "" : "s"} (a raid that ended with no pop, or cancelled after the AFK check).`;
  const canPost = Boolean(me) && !state.banned && !leading && !posting && !held && !busy(server);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true);
    try {
      const id = await state.create({ dungeonId, server, location, party: party.trim(), description: description.trim(), keys });
      if (id !== null) {
        setPosted(true);
        setDescription("");
        setTimeout(() => setPosted(false), 2500);
      }
    } finally {
      setPosting(false);
    }
  }

  return (
    <form className="raid-create" onSubmit={submit}>
      {!me && <p className="hint">Log in with your character to post a raid. Anyone can browse; joining and leading need a name.</p>}
      {me && state.banned && <p className="login-err">Your account is blocked from raids.</p>}
      {me && leading && <p className="hint">You are leading <strong>{dungeonFor(leading.dungeonId).dungeon}</strong>. End it before posting another.</p>}
      {me && held && <p className="login-err">{holdText}</p>}
      <label>Dungeon</label>
      <div className="raid-chosen">
        {chosen.portalImg && <img src={chosen.portalImg} alt="" width={40} height={40} />}
        <img src={chosen.keyImg} alt="" width={28} height={28} />
        <div>
          <strong>{chosen.dungeon}</strong>
          <div className="hint">{chosen.key} · party limit {chosen.limit}{chosen.portalType === null ? " · pop cannot be verified" : ""}</div>
        </div>
      </div>
      <input type="search" className="pool-search raid-pick-search" placeholder="Find a key…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="raid-pick-grid" role="listbox" aria-label="Keys">
        {picks.map((d) => (
          <button key={d.id} type="button" role="option" aria-selected={d.id === dungeonId} className={"raid-pick" + (d.id === dungeonId ? " active" : "")} title={`${d.key} — ${d.dungeon}`} onClick={() => setDungeonId(d.id)}>
            <img src={d.keyImg} alt={d.key} width={32} height={32} />
          </button>
        ))}
        {picks.length === 0 && <span className="hint">No key matches.</span>}
      </div>

      <label htmlFor="raid-server">Server</label>
      <select id="raid-server" value={server} onChange={(e) => setServer(e.target.value)}>
        {WITHDRAW_SERVERS.map((s) => <option key={s} value={s} disabled={busy(s)}>{s}{serverOffLabel(controls[s], "withdraw")}</option>)}
      </select>
      {busy(server) && <p className="hint">{server} is {controls[server]?.busy ? "busy" : "switched off"} right now; raids follow the same server rules as withdraws. Pick another server.</p>}

      <div className="raid-create-row">
        <div>
          <label htmlFor="raid-location">Pop location</label>
          <select id="raid-location" value={location} onChange={(e) => setLocation(e.target.value as Location)}>
            {LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="raid-party">Party name</label>
          <input id="raid-party" type="text" maxLength={state.limits.party} value={party} onChange={(e) => setParty(e.target.value)} placeholder="communist party" title="Your in-game party; raiders get it once the AFK check is complete" />
        </div>
      </div>

      <div className="raid-create-row">
        <div>
          <label htmlFor="raid-keys">Keys you have</label>
          <input id="raid-keys" type="number" min={0} max={state.limits.keys} value={keys} onChange={(e) => setKeys(Math.min(state.limits.keys, Math.max(0, Number(e.target.value) || 0)))} title="With more than one, you can call the next pop after each run" />
        </div>
        <div>
          <label>Party limit</label>
          <div className="raid-limit" title="Realm's player limit for this dungeon; the raid fills to it">{chosen.limit} players</div>
        </div>
      </div>

      <label htmlFor="raid-desc">Description</label>
      <textarea id="raid-desc" rows={3} maxLength={state.limits.description} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Full clear? Learning run? Anything raiders should know." />

      <button type="submit" className="raid-btn raid-post" disabled={!canPost}>{posted ? "Posted ✓" : me ? `Post raid as ${me}` : "Log in to post"}</button>
      <p className="hint">
        Only the region shows until you start the AFK check ({minutes(state.limits.afkSeconds)}); joining raiders then get the server and bazaar, and the party name once the check is complete.
        {state.watchers ? " A watcher bot goes into the bazaar to confirm your pop, who was there, and the modifiers." : ""} A headcount left alone closes after 30 minutes.
      </p>
    </form>
  );
}
