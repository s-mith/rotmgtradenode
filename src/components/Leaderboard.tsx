
import { useEffect, useState } from "react";
import PlayerName from "./PlayerName";
import type { NameStyle } from "@/lib/cosmetics";

type Player = {
  ign: string;
  // Donator name effect, or null for everyone else (see lib/cosmetics.ts).
  nameStyle: NameStyle | null;
  points: number;
  deposited: number;
  withdrawn: number;
};

type Boards = { comrades: Player[]; capitalists: Player[] };

// Contribution ranking: deposits earn points, withdrawals spend them.
// Per-item values are era-scoped and live in /api/leaderboard (see the
// "Leaderboard Points Adjustments" blog post for the current table).
//
// Two boards behind tab buttons that replace the panel heading:
//   Top Comrades         — the 50 highest positive-point players
//   Suspected Capitalists — the 50 most negative players, worst first
// Zero-point players appear on neither.
// Shares the tx-feed list styling so the aside panels read as one set.
export default function Leaderboard({ refreshKey }: { refreshKey: number }) {
  const [boards, setBoards] = useState<Boards | null>(null);
  const [tab, setTab] = useState<"comrades" | "capitalists">("comrades");
  const [lookup, setLookup] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leaderboard", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled)
          setBoards({
            comrades: data.comrades ?? [],
            capitalists: data.capitalists ?? [],
          });
      })
      .catch(() => {
        if (!cancelled) setBoards({ comrades: [], capitalists: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const players = boards === null ? null : boards[tab];

  return (
    <>
      <div className="pool-tabs board-tabs">
        <button
          className={"nav-link" + (tab === "comrades" ? " active" : "")}
          onClick={() => setTab("comrades")}
        >
          Top Comrades
        </button>
        <button
          className={"nav-link" + (tab === "capitalists" ? " active" : "")}
          onClick={() => setTab("capitalists")}
        >
          Suspected Capitalists
        </button>
      </div>
      <form
        className="board-lookup"
        onSubmit={(e) => {
          e.preventDefault();
          const ign = lookup.trim();
          if (ign) window.location.href = `/u/${encodeURIComponent(ign)}`;
        }}
      >
        <input
          type="search"
          placeholder="Look up a comrade…"
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
          maxLength={32}
        />
      </form>
      {players === null ? (
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      ) : players.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>
          {tab === "comrades"
            ? "No contributions yet — deposit to get on the board."
            : "No suspects. The collective is pure… for now."}
        </p>
      ) : (
        <ul className="tx-feed">
          {players.map((p, i) => (
            <li key={p.ign}>
              <span>
                <span style={{ color: "var(--muted)", display: "inline-block", minWidth: 24 }}>
                  {i + 1}.
                </span>
                <a className="ign-link" href={`/u/${encodeURIComponent(p.ign)}`}>
                  <PlayerName ign={p.ign} style={p.nameStyle} />
                </a>
              </span>
              <span
                className={"tx-kind " + (p.points >= 0 ? "deposit" : "withdraw")}
                title={`${p.deposited} deposited · ${p.withdrawn} withdrawn`}
                style={{ fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {formatPoints(p.points)} pts
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// 3 -> "+3", 3.25 -> "+3.25", -0.5 -> "−0.5" (real minus sign, matching
// the tx feed's glyphs).
function formatPoints(points: number): string {
  const sign = points > 0 ? "+" : points < 0 ? "−" : "";
  return sign + String(Math.abs(points));
}
