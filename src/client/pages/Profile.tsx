
// Comrade profile — the GitHub-profile treatment for the ledger. Header
// with rank/points/totals, a 53-week contribution calendar (green days
// gave to the collective, red days took from it), and the player's
// transactions as a commit log. All numbers come from /api/profile, which
// shares its scoring with the leaderboard.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import PlayerName from "@/components/PlayerName";
import type { NameStyle } from "@/lib/cosmetics";

type Day = { date: string; points: number; deposited: number; withdrawn: number };

type Activity = {
  kind: "deposit" | "withdraw" | "raid";
  itemName: string;
  sprite: string | null;
  qty: number;
  enchants: number;
  points: number;
  server: string | null;
  createdAt: number;
};

type Profile = {
  ign: string;
  nameStyle: NameStyle | null;
  points: number;
  rank: number | null;
  raids?: { led: number; popped: number; poppedByOthers?: number; noPop: number; cancelled?: number; strikes?: number; joined: number; present: number; points?: number };
  totalPlayers: number;
  deposited: number;
  withdrawn: number;
  comradeSince: number | null;
  baselineOnly: boolean;
  days: Day[];
  activity: Activity[];
  signature: { itemName: string; sprite: string | null; qty: number } | null;
};

const WEEKS = 53;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Intensity buckets, mirrored for red. Thresholds are in |net points|.
function level(points: number): number {
  const a = Math.abs(points);
  if (a === 0) return 0;
  if (a <= 0.5) return 1;
  if (a <= 2) return 2;
  if (a <= 5) return 3;
  return 4;
}

function Calendar({ days }: { days: Day[] }) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  // Columns are weeks (Sunday-first, like GitHub). Start from the Sunday
  // on/before (today - 52 weeks) and run through today.
  const weeks = useMemo(() => {
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const start = todayUtc - (WEEKS * 7 - 1) * DAY_MS;
    const startSunday = start - new Date(start).getUTCDay() * DAY_MS;
    const cols: { date: string; inRange: boolean }[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col: { date: string; inRange: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const ms = startSunday + (w * 7 + d) * DAY_MS;
        col.push({ date: utcDayKey(ms), inRange: ms <= todayUtc });
      }
      cols.push(col);
    }
    return cols;
  }, []);

  // Month labels: mark a column when the month changes at its first cell.
  const monthLabels = useMemo(() => {
    const labels: (string | null)[] = [];
    let last = "";
    for (const col of weeks) {
      const m = col[0].date.slice(0, 7);
      if (m !== last) {
        last = m;
        const monthIdx = Number(m.slice(5)) - 1;
        labels.push(
          ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][monthIdx],
        );
      } else {
        labels.push(null);
      }
    }
    return labels;
  }, [weeks]);

  return (
    <div className="cal-wrap">
      <div className="cal-months">
        {monthLabels.map((m, i) => (
          <span key={i}>{m ?? ""}</span>
        ))}
      </div>
      <div className="cal">
        {weeks.map((col, wi) => (
          <div className="cal-week" key={wi}>
            {col.map((cell) => {
              const d = byDate.get(cell.date);
              const pts = d?.points ?? 0;
              const lv = cell.inRange ? level(pts) : 0;
              const cls =
                "cal-day" +
                (!cell.inRange
                  ? " out"
                  : pts > 0
                    ? ` give-${lv}`
                    : pts < 0
                      ? ` take-${lv}`
                      : "");
              const title = d
                ? `${cell.date} — ${pts > 0 ? "+" : ""}${pts} pts (${d.deposited} deposited, ${d.withdrawn} withdrawn)`
                : `${cell.date} — no activity`;
              return <span key={cell.date} className={cls} title={title} />;
            })}
          </div>
        ))}
      </div>
      <div className="cal-legend">
        <span>took</span>
        <span className="cal-day take-4" />
        <span className="cal-day take-2" />
        <span className="cal-day" />
        <span className="cal-day give-2" />
        <span className="cal-day give-4" />
        <span>gave</span>
      </div>
    </div>
  );
}

function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtPoints(points: number): string {
  const sign = points > 0 ? "+" : points < 0 ? "−" : "";
  return sign + String(Math.abs(points));
}

export default function ProfilePage() {
  const params = useParams<{ ign: string }>();
  const ign = decodeURIComponent(params.ign ?? "");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ign) return;
    let cancelled = false;
    fetch(`/api/profile?ign=${encodeURIComponent(ign)}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) setErr(data.error ?? `HTTP ${r.status}`);
        else setProfile(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [ign]);

  return (
    <main>
      <header className="site">
        <a className="title-link" href="/" aria-label="RotMG Communism">
          <img src="/logo.png" alt="" className="title-logo" width={48} height={48} />
          RotMG Communism
        </a>
        <span className="tag">the collective remembers every contribution</span>
      </header>

      {err ? (
        <div className="panel">
          <h2>Unknown comrade</h2>
          <p style={{ color: "var(--muted)" }}>
            No record of “{ign}” in the ledger. <a href="/">Back to the pool.</a>
          </p>
        </div>
      ) : profile === null ? (
        <p style={{ color: "var(--muted)" }}>Reviewing the ledger…</p>
      ) : (
        <>
          <div className="panel profile-head">
            <div className="profile-id">
              <h2>
                <PlayerName ign={profile.ign} style={profile.nameStyle} />
              </h2>
              <span className={"profile-points " + (profile.points >= 0 ? "tx-kind deposit" : "tx-kind withdraw")}>
                {fmtPoints(profile.points)} pts
              </span>
              {profile.rank !== null && (
                <span className="profile-rank">
                  rank #{profile.rank} of {profile.totalPlayers}
                </span>
              )}
            </div>
            <div className="profile-stats">
              <span>
                <strong>{profile.deposited}</strong> deposited
              </span>
              <span>
                <strong>{profile.withdrawn}</strong> withdrawn
              </span>
              {profile.signature && (
                <span className="profile-sig" title={`most deposited: ${profile.signature.itemName} ×${profile.signature.qty}`}>
                  signature item:{" "}
                  {profile.signature.sprite && (
                    <img src={profile.signature.sprite} alt="" className="profile-sig-sprite" />
                  )}
                  {profile.signature.itemName}
                </span>
              )}
              {profile.raids && (profile.raids.led > 0 || profile.raids.joined > 0) && (
                <span title={[profile.raids.noPop ? `${profile.raids.noPop} raid(s) ended with no pop seen` : "", profile.raids.cancelled ? `${profile.raids.cancelled} cancelled after the AFK check` : "", profile.raids.poppedByOthers ? `${profile.raids.poppedByOthers} popped by someone else` : ""].filter(Boolean).join(" · ") || undefined}>
                  <strong>{profile.raids.led}</strong> raid{profile.raids.led === 1 ? "" : "s"} led
                  {profile.raids.led > 0 ? ` (${profile.raids.popped} popped by them)` : ""}
                  {profile.raids.strikes ? `, ${profile.raids.strikes} active strike${profile.raids.strikes === 1 ? "" : "s"}` : ""}
                  {profile.raids.joined > 0 ? `, ${profile.raids.joined} joined (${profile.raids.present} showed up)` : ""}
                  {profile.raids.points ? `, ${fmtPoints(profile.raids.points)} pts from raids` : ""}
                </span>
              )}
              <span>
                {profile.comradeSince
                  ? `comrade since ${new Date(profile.comradeSince).toLocaleDateString()}`
                  : "points carried over from the old ledger"}
              </span>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 24 }}>
            <h2>Contributions</h2>
            <Calendar days={profile.days} />
          </div>

          <div className="panel" style={{ marginTop: 24 }}>
            <h2>Activity</h2>
            {profile.activity.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>
                Nothing in the current ledger — this comrade&rsquo;s deeds predate the database.
              </p>
            ) : (
              <ul className="tx-feed profile-feed">
                {profile.activity.map((a, i) => (
                  <li key={i}>
                    <span className="profile-feed-main">
                      <strong className={`tx-kind ${a.kind}`}>
                        {a.kind === "raid" ? "⚔" : a.kind === "deposit" ? `+${a.qty}` : `−${a.qty}`}
                      </strong>{" "}
                      {a.sprite && <img src={a.sprite} alt="" className="profile-feed-sprite" />}
                      <span title={a.itemName}>{a.itemName}</span>
                      {a.enchants > 0 && (
                        <span
                          className="profile-feed-ench"
                          title={`${a.enchants} enchantment${a.enchants === 1 ? "" : "s"}`}
                        >
                          ✦{a.enchants}
                        </span>
                      )}
                      <span className="profile-feed-pts mono">
                        {fmtPoints(a.points)} pts
                      </span>
                    </span>
                    <span className="tx-time">
                      {a.server ? `${a.server} · ` : ""}
                      {relTime(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </main>
  );
}
