"use client";

// Realmhunting: the second sub-tab under the Raids bookmark, next to Keys
// (the dungeon raids in Raids.tsx). A hunt is a request for a dungeon in a
// region; a fleet bot goes to a server there and holds an in-game party
// open from the Nexus ("realmhunt Moonlight Village US"). The hunters roam
// realms for the dungeon; when one is inside it and says "j" in party chat
// the bot teleports to them through the party, counts who follows within
// 30 s and nexuses (docs/REALMHUNTS.md).
//
// The list comes from /api/realmhunts and is refetched on the live stream's
// "realmhunts" events. Nothing is hidden: the server and the party name are
// what a hunter needs to find the bot.
import { useCallback, useEffect, useMemo, useState } from "react";
import { RAID_DUNGEONS, type RaidDungeon } from "@/lib/raidDungeons";
import CopyText from "./CopyText";
import { CALL_OUTCOME_LABEL, HUNTER_LABEL, partyName, type HuntView } from "@/lib/realmhuntRules";

export type RaidsTab = "keys" | "realmhunting";
export type Hunt = HuntView;

function dungeonFor(id: string): RaidDungeon {
  return RAID_DUNGEONS.find((d) => d.id === id) ?? RAID_DUNGEONS[0];
}
function ago(t: number, now: number): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The hunt list and the actions on it. `active` says the tab is showing, so a live event refetches at once. */
export function useRealmhunts(me: string | null, active: boolean) {
  const [hunts, setHunts] = useState<Hunt[]>([]);
  const [regions, setRegions] = useState<string[]>(["US", "EU"]);
  const [joinWindowSeconds, setJoinWindowSeconds] = useState(30);
  const [idleMinutes, setIdleMinutes] = useState(20);
  const [hunters, setHunters] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/realmhunts", { cache: "no-store" });
      const d = (await r.json()) as { hunts?: Hunt[]; regions?: string[]; limits?: { joinWindowSeconds: number; idleMinutes: number }; hunters?: boolean; error?: string };
      if (!r.ok || !d.hunts) throw new Error(d.error || `HTTP ${r.status}`);
      setHunts(d.hunts);
      if (d.regions?.length) setRegions(d.regions);
      if (d.limits) {
        setJoinWindowSeconds(d.limits.joinWindowSeconds);
        setIdleMinutes(d.limits.idleMinutes);
      }
      setHunters(Boolean(d.hunters));
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, me]);

  // A live "realmhunts" event: refetch. The list is small and the Raids
  // bookmark's badge counts open hunts from every tab, so it has to stay
  // right when this tab is not showing.
  void active;
  const onLive = useCallback(() => {
    void refresh();
  }, [refresh]);

  async function post(url: string, body: unknown): Promise<Hunt | null> {
    setError(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json()) as { error?: string; hunt?: Hunt };
      if (!r.ok || !d.hunt) {
        setError(d.error || `HTTP ${r.status}`);
        return null;
      }
      await refresh();
      return d.hunt;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  return {
    hunts, regions, joinWindowSeconds, idleMinutes, hunters, loaded, error, setError, refresh, onLive,
    create: (input: { dungeonId: string; region: string }) => post("/api/realmhunts", input),
  };
}
export type RealmhuntsState = ReturnType<typeof useRealmhunts>;

const STATE_CLASS: Partial<Record<Hunt["hunter"]["state"], string>> = { hunting: "raid-status-running", counting: "raid-status-afk", joining: "raid-status-afk", failed: "raid-status-ended", left: "raid-status-ended" };

/** The main panel: every hunt, with where its bot is and what each call counted. */
export function RealmhuntingFinder({ state, me }: { state: RealmhuntsState; me: string | null }) {
  const [status, setStatus] = useState<"open" | "ended" | "all">("open");
  const now = useNow();
  const shown = state.hunts.filter((h) => status === "all" || (status === "open" ? h.status !== "ended" : h.status === "ended"));

  return (
    <div className="raids">
      <div className="raids-chips" role="group" aria-label="Status">
        {(["open", "ended", "all"] as const).map((s) => (
          <button key={s} type="button" className={"login-char-btn" + (status === s ? " wish-pool-active" : "")} aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === "open" ? "Open" : s === "ended" ? "Ended" : "All"}
          </button>
        ))}
      </div>
      {state.error && <p className="login-err raids-err">{state.error}</p>}
      <ul className="raid-list">
        {!state.loaded && <li className="hint">Loading hunts…</li>}
        {state.loaded && shown.length === 0 && <li className="hint">{state.hunts.length === 0 ? "No hunts right now. Request one on the right." : "No hunts match."}</li>}
        {shown.map((h) => {
          const d = dungeonFor(h.dungeonId);
          const ended = h.status === "ended";
          const counted = h.calls.filter((c) => c.outcome === "counted");
          const total = counted.reduce((n, c) => n + (c.entered ?? 0), 0);
          return (
            <li key={h.id} className={"raid-card hunt-card" + (ended ? " ended" : "")}>
              <div className="raid-portal">{d.portalImg ? <img src={d.portalImg} alt="" width={56} height={56} /> : <img src={d.keyImg} alt="" width={40} height={40} />}</div>
              <div className="raid-main">
                <div className="raid-title">
                  <strong>{d.dungeon}</strong>
                  <span className="raid-rl">{h.region}</span>
                  <span className={"raid-status " + (ended ? "raid-status-ended" : STATE_CLASS[h.hunter.state] ?? "raid-status-headcount")}>
                    {ended ? `ended · ${h.endedBy === "hunter" ? "hunter failed" : h.endedBy === "timeout" ? "timed out" : h.endedBy === "idle" ? "no call for 20 min" : h.endedBy === "operator" ? "closed by an operator" : h.endedBy ?? ""}` : HUNTER_LABEL[h.hunter.state]}
                  </span>
                </div>
                <div className="raid-meta">
                  <span>party <CopyText text={h.partyName} title="Copy the party name to find it in game" /></span>
                  <span>{h.server}</span>
                  <span>{h.members.length} in the party</span>
                  <span>requested by <b>{h.requester}</b> {ago(h.createdAt, now)}</span>
                </div>
                {h.hunter.note && <div className="hint hunt-note">{h.hunter.note}</div>}
                {h.calls.length > 0 && (
                  <div className="hunt-calls">
                    <span className="raid-count">{counted.length} counted · {total} joined in all</span>
                    {h.calls.slice(-6).map((c) => (
                      <span key={c.id} className={"raid-react hunt-call" + (c.outcome === "counted" ? " ok" : c.outcome ? " bad" : "")} title={[c.note, new Date(c.at).toLocaleTimeString()].filter(Boolean).join(" · ")}>
                        {c.caller}: {c.outcome === null ? "…" : c.outcome === "counted" || c.outcome === "other_dungeon" ? `${c.entered} in (${c.partyEntered} party)${c.outcome === "other_dungeon" ? ", wrong dungeon" : ""}${c.finderPoints ? ` +${c.finderPoints}` : ""}` : CALL_OUTCOME_LABEL[c.outcome]}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="raid-actions" />
            </li>
          );
        })}
      </ul>
      {me === null && state.loaded && <p className="hint">Log in to request a hunt. Anyone can browse; joining a hunt happens in game, through its party.</p>}
    </div>
  );
}

/** The side panel: request a hunt. */
export function RealmhuntingSide({ state, me }: { state: RealmhuntsState; me: string | null }) {
  const [query, setQuery] = useState("");
  const [dungeonId, setDungeonId] = useState<string>(RAID_DUNGEONS.find((d) => d.id === "moonlight-village-key")?.id ?? RAID_DUNGEONS[0].id);
  const [region, setRegion] = useState<string>("US");
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const picks = useMemo(() => RAID_DUNGEONS.filter((d) => !query || `${d.dungeon} ${d.key}`.toLowerCase().includes(query.toLowerCase())), [query]);
  const chosen = dungeonFor(dungeonId);
  const mine = state.hunts.find((h) => h.requesting && h.status !== "ended") ?? null;
  const canPost = Boolean(me) && !mine && !posting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true);
    try {
      const h = await state.create({ dungeonId, region });
      if (h) {
        setPosted(true);
        setTimeout(() => setPosted(false), 2500);
      }
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="panel">
      <h2>Request a hunt</h2>
      <form className="raid-create" onSubmit={submit}>
        {!me && <p className="hint">Log in with your character to request a hunt.</p>}
        {me && mine && <p className="hint">Your <strong>{dungeonFor(mine.dungeonId).dungeon}</strong> hunt is open. It closes on its own once its party has had no call for {Math.round(state.idleMinutes)} minutes.</p>}
        <label>Dungeon</label>
        <div className="raid-chosen">
          {chosen.portalImg && <img src={chosen.portalImg} alt="" width={40} height={40} />}
          <div>
            <strong>{chosen.dungeon}</strong>
            <div className="hint">party of {chosen.limit}{chosen.portalType === null ? " · portal unknown, matched by name" : ""}</div>
          </div>
        </div>
        <input type="search" className="pool-search raid-pick-search" placeholder="Find a dungeon…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="raid-pick-grid" role="listbox" aria-label="Dungeons">
          {picks.map((d) => (
            <button key={d.id} type="button" role="option" aria-selected={d.id === dungeonId} className={"raid-pick" + (d.id === dungeonId ? " active" : "")} title={d.dungeon} onClick={() => setDungeonId(d.id)}>
              <img src={d.portalImg ?? d.keyImg} alt={d.dungeon} width={32} height={32} />
            </button>
          ))}
          {picks.length === 0 && <span className="hint">No dungeon matches.</span>}
        </div>
        <label htmlFor="hunt-region">Region</label>
        <select id="hunt-region" value={region} onChange={(e) => setRegion(e.target.value)}>
          {state.regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <label>Party</label>
        <div className="raid-limit" title="The in-game party the bot opens; find it in the party finder"><CopyText text={partyName(chosen.dungeon, region)} title="Copy the party name" /> · {chosen.limit} players</div>
        <button type="submit" className="raid-btn raid-post" disabled={!canPost}>{posted ? "Requested ✓" : me ? `Request as ${me}` : "Log in to request"}</button>
        <p className="hint">
          Points like raids: on a counted call every party member the bot saw in the dungeon earns 0.1, and the finder earns 0.1 per member who followed, paid to names with a site account. A bot picks a quiet {region} server and opens the party from the Nexus. Join it in game and hunt any realm for a {chosen.dungeon}. Once you are inside one, say <b>j</b> in party chat: the bot teleports to you through the party, counts who joins for {state.joinWindowSeconds}s, then nexuses and waits for the next call. It leaves the party after {Math.round(state.idleMinutes)} minutes without a call into a {chosen.dungeon}; every such call restarts that clock. Nobody closes a hunt by hand: it ends when its party goes quiet.
          {state.hunters ? "" : " No fleet is attached right now, so a hunt is posted without a bot."}
        </p>
      </form>
    </div>
  );
}
