import { useCallback, useEffect, useState } from "react";
// Node: the build gate, the version feed, the hub link and ban telemetry
// (design doc §8), rendered at the bottom of the Overview tab (the server
// list is a tile there). Everything on this tab is about keeping the
// node's own accounts safe: no login on a Realm build that has not been
// seen to work, and a way to tell the hub when an account is suspended.

type Status = {
  version: string;
  feed: { polling: boolean; lastFetchAt: number; lastError: string | null; info: { gameVersion: string; metadataVersion: string; updatedAt: string } | null };
  build: { build: string; known: boolean; held: boolean; reason: string | null; knownBuilds: string[]; canary: { running: boolean; last: { ok: boolean; build: string; ign?: string; seconds?: number; reason?: string } | null } };
  servers: { fetchedAt: number; stale: boolean; lastError: string | null; servers: Record<string, string> };
  telemetry: { enabled: boolean; hubUrl: string; queued: number; sent: number; lastFlushAt: number | null; lastError: string | null };
  hub: { linked: boolean; url: string | null; nodeId: string | null; email: string | null; linkedAt: number | null; lastHeartbeatAt: number | null; lastError: string | null; outdated: boolean; loginNode?: boolean; version: { minNodeVersion: string; latestNodeVersion: string; downloadUrl: string; build: { gameVersion: string; knownBuilds: string[] } } | null };
  players?: { enabled: boolean; maxMeetings: number | null; noShow: { limit: number; pauseHours: number }; onlineCap: number; atOnce: number };
  loginDesk?: { alwaysOn: boolean; wanted: boolean; until: number | null; bot: string | null };
  realmLogins?: { active: boolean; pending: number; served: number; lastError: string | null };
  advanced?: { pool: boolean; communism: boolean; mergeBudget: "unlimited" | "demand"; lingerS: number; passSurplus: boolean };
  advancedStatus?: { intake?: Record<string, { empties: number; room: number; largest: number }>; counts?: Record<string, number>; pendingMoves?: number; onlineTrips?: number; logins?: { minted: number; reused: number; reuseFailed: number } };
};

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "never");

export default function NodeTab({ password }: { password: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const DEFAULT_HUB = "https://rotmg.trade";
  const [hubUrl, setHubUrl] = useState(DEFAULT_HUB);
  const [linkUrl, setLinkUrl] = useState(DEFAULT_HUB);
  const [linkCode, setLinkCode] = useState("");
  const headers = { "X-Dev-Password": password, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/node", { headers });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setStatus(data as Status);
      setHubUrl((h) => (data as Status).telemetry.hubUrl || h);
      setLinkUrl((u) => (data as Status).hub.url || u);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/dev/node", { method: "POST", headers, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) setError(data.error || (data.canary?.reason ? `canary: ${data.canary.reason}` : `HTTP ${r.status}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void load();
    }
  }

  const b = status?.build;
  const t = status?.telemetry;
  const h = status?.hub;
  const pl = status?.players;
  const ld = status?.loginDesk;
  const adv = status?.advanced;
  const rl = status?.realmLogins;
  const last = b?.canary.last;
  return (
    <section>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}

      <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Realm build</b>{" "}
        {b ? (
          <>
            <span style={{ fontFamily: "monospace" }}>{b.build}</span>{" · "}
            {b.held ? <span style={{ color: "var(--bad)" }}>logins held</span> : <span style={{ color: "var(--good, #5aa86a)" }}>known, logins open</span>}
            {b.reason && <div style={{ color: "var(--muted, #999)", fontSize: 12, marginTop: 4 }}>{b.reason}</div>}
            <div style={{ color: "var(--muted, #999)", fontSize: 12, marginTop: 4 }}>
              feed: {status?.feed.polling ? `polled, last ${when(status.feed.lastFetchAt)}` : "off"}{status?.feed.lastError ? ` (${status.feed.lastError})` : ""}
              {status?.feed.info ? ` · feed says ${status.feed.info.gameVersion}, metadata ${status.feed.info.metadataVersion || "?"}` : ""}
              {" · known builds: "}{b.knownBuilds.join(", ")}
            </div>
            {last && (
              <div style={{ fontSize: 12, marginTop: 4, color: last.ok ? "var(--good, #5aa86a)" : "var(--bad)" }}>
                last canary on {last.build}: {last.ok ? `${last.ign} held the world (${last.seconds}s)` : last.reason}
              </div>
            )}
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={busy || b.canary.running} onClick={() => void act({ action: "canary" }, "Log ONE account in on this build to see whether the node's codecs still work? If Realm kicks it, the hold stays on. Use an account you would not mind losing.")}>
                {b.canary.running ? "canary running…" : "Run a canary login"}
              </button>
              {b.held && (
                <button disabled={busy} onClick={() => void act({ action: "trust" }, "Record this build as known WITHOUT a canary? Every account may then log in on it. Only do this if you know the protocol did not change.")}>
                  Trust this build
                </button>
              )}
            </div>
          </>
        ) : "…"}
      </div>

      <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Hub</b>{" "}
        {h ? (
          h.linked ? (
            <>
              <span style={{ color: "var(--good, #5aa86a)" }}>linked</span>
              <div style={{ color: "var(--muted, #999)", fontSize: 12, marginTop: 4 }}>
                {h.url} · as {h.email} · node {h.nodeId} · since {when(h.linkedAt)} · last heartbeat {when(h.lastHeartbeatAt)}
                {h.lastError ? ` · ${h.lastError}` : ""}
                {h.version ? ` · hub wants node ≥ ${h.version.minNodeVersion}${h.outdated ? " (this node is older: hub features off until updated)" : ""}` : ""}
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button disabled={busy} onClick={() => void act({ action: "hub-heartbeat" })}>Heartbeat now</button>
                <button disabled={busy} onClick={() => void act({ action: "hub-unlink" }, "Unlink this node from the hub? Its key is forgotten; offers and communism from this node disappear from the hub.")}>Unlink</button>
              </div>
            </>
          ) : (
            <>
              <span style={{ color: "var(--muted, #999)" }}>local mode (not linked)</span>
              <p style={{ color: "var(--muted, #999)", fontSize: 12, margin: "6px 0", maxWidth: 640 }}>
                Everything on the main page works without rotmg trade. Linking unlocks offers between nodes and communism.
                Sign in to rotmg trade, open <b>my nodes</b>, press <b>link my node</b> and paste the code here. The code registers this
                node&apos;s key once and is then spent; no password ever touches this machine, and your game accounts never leave it.
              </p>
              <form
                onSubmit={(e) => { e.preventDefault(); void act({ action: "hub-link", url: linkUrl, code: linkCode, name: "my node" }); setLinkCode(""); }}
                style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
              >
                <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder={DEFAULT_HUB} style={{ width: 220 }} />
                <input value={linkCode} onChange={(e) => setLinkCode(e.target.value)} placeholder="link code from rotmg trade" style={{ width: 200, fontFamily: "monospace" }} autoComplete="off" spellCheck={false} />
                <button type="submit" disabled={busy || !linkUrl || !linkCode.trim()}>Link</button>
              </form>
              {h.lastError && <div style={{ color: "var(--bad)", fontSize: 12, marginTop: 4 }}>{h.lastError}</div>}
            </>
          )
        ) : "…"}
      </div>

      <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Login desk</b>{" "}
        {ld ? (
          <>
            <span style={{ color: ld.alwaysOn ? "var(--good, #5aa86a)" : "var(--muted, #999)" }}>{ld.alwaysOn ? "always on" : "on demand"}</span>
            <span style={{ color: "var(--muted, #999)", fontSize: 12 }}>
              {" · "}{ld.bot ? `${ld.bot} is at the desk` : ld.wanted ? "a bot is logging in for someone" : "no bot at the desk"}
              {ld.until ? ` · stays until ${new Date(ld.until).toLocaleTimeString()}` : ""}
            </span>
            <p style={{ color: "var(--muted, #999)", fontSize: 12, margin: "6px 0", maxWidth: 640 }}>
              People log in by whispering a code to a bot in game: on this node&apos;s site, and on rotmg trade when the hub signs people in
              through this node. On demand, a bot logs in only when someone asks for a code, and the code shows once that bot is in the game
              to receive it: about a minute&apos;s wait, and no account sits online for nothing. Always on keeps one bot in game all the time,
              so codes show at once. On demand by default.
            </p>
            <button disabled={busy} onClick={() => void act({ action: "login-desk", alwaysOn: !ld.alwaysOn })}>{ld.alwaysOn ? "Only when someone logs in" : "Keep one in game all the time"}</button>
          </>
        ) : "…"}
      </div>

      <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Advanced management</b>{" "}
        {adv ? (
          <>
            <span style={{ color: adv.pool || adv.communism ? "var(--good, #5aa86a)" : "var(--muted, #999)" }}>
              standard accounts {adv.pool ? "on" : "off"} · communism {adv.communism ? "on" : "off"}
            </span>
            <p style={{ color: "var(--muted, #999)", fontSize: 12, margin: "6px 0", maxWidth: 640 }}>
              Optional, for nodes with many accounts. It keeps items tidy in the background so trades are quicker, but bots log in more often.
              Off by default; leave it off unless you want it.
            </p>
            <AdvancedSwitch
              name="Standard accounts"
              on={adv.pool}
              busy={busy}
              what="Deposits go to an empty character in one trade, potions are kept together by kind, and a withdraw comes from as few bots as possible."
              toggle={() => void act({ action: "advanced", pool: !adv.pool }, adv.pool ? undefined : "Turn on advanced management for standard accounts? Bots will bank, tidy and merge items in the background, which logs them in more often.")}
            />
            <AdvancedSwitch
              name="Communism accounts"
              on={adv.communism}
              busy={busy}
              what="The same for communism, and people on rotmg trade can ask for “N of this potion”."
              toggle={() => void act({ action: "advanced", communism: !adv.communism }, adv.communism ? undefined : "Turn on advanced management for communism accounts? Bots will bank, tidy and merge communism items in the background, which logs them in more often.")}
            />
            {(adv.pool || adv.communism) && (
              <details className="ui-more">
                <summary>More options</summary>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                  <label>
                    wake bots to merge potions{" "}
                    <select value={adv.mergeBudget} disabled={busy} onChange={(e) => void act({ action: "advanced", mergeBudget: e.target.value })}>
                      <option value="unlimited">as often as it helps (fewest potion trades)</option>
                      <option value="demand">tied to potion withdraws (less bot time)</option>
                    </select>
                  </label>
                  <label>
                    after work, stay online{" "}
                    <select value={adv.lingerS} disabled={busy} onChange={(e) => void act({ action: "advanced", lingerS: Number(e.target.value) })}>
                      <option value={0}>0 s (least online time)</option>
                      <option value={15}>15 s in the Vault (fewer logins)</option>
                    </select>
                  </label>
                  {adv.communism && (
                    <label title="When communism accounts run out of room, give surplus to other nodes' communism through the hub (needs the hub link).">
                      <input type="checkbox" checked={adv.passSurplus} disabled={busy} onChange={(e) => void act({ action: "advanced", passSurplus: e.target.checked })} /> pass communism surplus to other nodes
                    </label>
                  )}
                </div>
              </details>
            )}
            {(adv.pool || adv.communism) && status?.advancedStatus && <AdvancedLine s={status.advancedStatus} />}
          </>
        ) : "…"}
      </div>

      {h?.linked && (
        <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
          <b>Trades with players</b>{" "}
          {pl ? (
            <>
              <span style={{ color: pl.enabled ? "var(--good, #5aa86a)" : "var(--muted, #999)" }}>{pl.enabled ? `on, up to ${pl.atOnce} at once` : "off"}</span>
              <p style={{ color: "var(--muted, #999)", fontSize: 12, margin: "6px 0", maxWidth: 640 }}>
                When on, people on rotmg trade who run no node can take this node&apos;s offers with their own character: the bot holding the items
                logs in on the meeting&apos;s server and waits in the nexus; they /trade it, put up what the offer asks for and accept; the bot checks
                their side and accepts after them, never first. Someone who does not come costs a login and a wait. Off by default.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button disabled={busy} onClick={() => void act({ action: "players", enabled: !pl.enabled }, pl.enabled ? undefined : "Let players on the hub take this node's offers in game? Your bots will log in and wait in the nexus for people you do not know.")}>{pl.enabled ? "Turn off" : "Turn on"}</button>
                <label style={{ fontSize: 12 }}>
                  at most{" "}
                  <select value={pl.maxMeetings ?? ""} disabled={busy} onChange={(e) => void act({ action: "players", maxMeetings: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">one per bot online ({pl.onlineCap})</option>
                    {Array.from({ length: Math.min(64, Math.max(8, pl.onlineCap)) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>{" "}
                  meeting{pl.atOnce === 1 ? "" : "s"} at a time
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8, fontSize: 12 }}>
                <span>Someone who does not come:</span>
                <label>
                  pause them after{" "}
                  <input type="number" min={0} max={100} style={{ width: 56 }} disabled={busy} defaultValue={pl.noShow.limit} key={`l${pl.noShow.limit}`}
                    onBlur={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 0 && v !== pl.noShow.limit) void act({ action: "players", noShow: { limit: v, pauseHours: pl.noShow.pauseHours } }); }} />{" "}
                  no-show{pl.noShow.limit === 1 ? "" : "s"} in a day
                </label>
                <label>
                  for{" "}
                  <input type="number" min={0} max={720} style={{ width: 56 }} disabled={busy} defaultValue={pl.noShow.pauseHours} key={`h${pl.noShow.pauseHours}`}
                    onBlur={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 0 && v !== pl.noShow.pauseHours) void act({ action: "players", noShow: { limit: pl.noShow.limit, pauseHours: v } }); }} />{" "}
                  hours
                </label>
                <span style={{ color: "var(--muted, #999)" }}>{pl.noShow.limit === 0 || pl.noShow.pauseHours === 0 ? "(0: never paused)" : "(0 turns it off)"}</span>
              </div>
            </>
          ) : "…"}
          {h.loginNode && (
            <div style={{ marginTop: 10, fontSize: 12 }}>
              <b>Login node</b>{" "}
              <span style={{ color: "var(--good, #5aa86a)" }}>the hub signs people in through this node</span>
              <div style={{ color: "var(--muted, #999)", marginTop: 4, maxWidth: 640 }}>
                People prove which character they play by whispering a code to this node&apos;s login desk bot. {rl ? `${rl.pending} code${rl.pending === 1 ? "" : "s"} waiting · ${rl.served} passed on since start${rl.lastError ? ` · ${rl.lastError}` : ""}` : ""}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Ban telemetry</b>{" "}
        {t ? (
          <>
            <span style={{ color: t.enabled ? "var(--good, #5aa86a)" : "var(--muted, #999)" }}>{t.enabled ? "on" : "off"}</span>
            <p style={{ color: "var(--muted, #999)", fontSize: 12, margin: "6px 0", maxWidth: 640 }}>
              Off by default. When on, each suspension the node sees is reported to the hub: a salted hash in place of the email (the salt never leaves
              this machine), when it was suspended, what it was last doing, how many items it held, seasonality, and the node and Realm versions. Nothing
              else. The hub joins reports across nodes so a ban wave shows while it is starting.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} placeholder={DEFAULT_HUB} style={{ width: 260 }} />
              <button disabled={busy} onClick={() => void act({ action: "telemetry", enabled: !t.enabled, hubUrl })}>{t.enabled ? "Turn off" : "Turn on"}</button>
              {t.enabled && <button disabled={busy} onClick={() => void act({ action: "flush" })}>Send now</button>}
              <span style={{ color: "var(--muted, #999)", fontSize: 12 }}>queued {t.queued} · sent {t.sent} · last sent {when(t.lastFlushAt)}{t.lastError ? ` · ${t.lastError}` : ""}</span>
            </div>
          </>
        ) : "…"}
      </div>
    </section>
  );
}

/** One line of what advanced management is doing: empty characters per side, then the work done since the node started. */
function AdvancedLine({ s }: { s: NonNullable<Status["advancedStatus"]> }) {
  const sides: [string, string][] = [["p|s", "standard seasonal"], ["p|n", "standard non-seasonal"], ["c|s", "communism seasonal"], ["c|n", "communism non-seasonal"]];
  const empties = sides.filter(([k]) => s.intake?.[k]).map(([k, name]) => `${name}: ${s.intake![k].empties} empty (${s.intake![k].room} slots)`);
  const c = s.counts ?? {};
  const done = ([["banks", "bank trip", "bank trips"], ["merges", "merge", "merges"], ["evacuations", "evacuation", "evacuations"], ["compactions", "compaction", "compactions"], ["gathers", "potion gathering run", "potion gathering runs"], ["onlineFetches", "live fetch", "live fetches"], ["prewakes", "early wake", "early wakes"], ["rotations", "switch to an empty character", "switches to an empty character"]] as const)
    .filter(([k]) => c[k])
    .map(([k, one, many]) => `${c[k]} ${c[k] === 1 ? one : many}`);
  const logins = s.logins && s.logins.minted + s.logins.reused ? `logins: ${s.logins.reused} on a kept token, ${s.logins.minted} with a new one` : null;
  return (
    <p style={{ color: "var(--muted, #999)", fontSize: 12, margin: "8px 0 0", maxWidth: 640 }}>
      {empties.length ? empties.join(" · ") : "no empty character on any side — deposits go the old way until one is freed"}
      {done.length ? <><br />since start: {done.join(", ")}</> : null}
      {logins ? <><br />{logins}</> : null}
    </p>
  );
}

/** One pool's switch: its name, on or off, what it does in a line, and the button. */
function AdvancedSwitch({ name, on, busy, what, toggle }: { name: string; on: boolean; busy: boolean; what: string; toggle: () => void }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "6px 0" }}>
      <button type="button" disabled={busy} onClick={toggle} aria-pressed={on} style={{ minWidth: 72 }}>{on ? "Turn off" : "Turn on"}</button>
      <span style={{ fontSize: 13 }}>
        <b>{name}</b> <span style={{ color: on ? "var(--good, #5aa86a)" : "var(--muted, #999)" }}>{on ? "on" : "off"}</span>
        <span style={{ color: "var(--muted, #999)", fontSize: 12, display: "block", maxWidth: 560 }}>{what}</span>
      </span>
    </div>
  );
}
