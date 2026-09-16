import { useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";
import { ItemSprite } from "@/components/ItemSprite";
import { effectLabel } from "@/components/TagSearch";

// Operator view of what every player has wishlisted (lib/wishlist.ts): one
// card per account with its linked names, the room left in each vault half,
// and every standing wish with its pool, slot requirement and filters.
// Read-only — wishes are the player's to keep or drop.

type MatchTerm = { kind: "ench"; name: string } | { kind: "effect"; key: string };
type SlotSpec = { any: { all: MatchTerm[] }[] };
type Rule = {
  id: number;
  seasonal: boolean;
  itemId: string;
  itemName: string;
  slotsMin: number;
  slotsExact: number | null;
  enchants: SlotSpec[];
  enabled: boolean;
  createdAt: number;
};
type Room = { seasonal: boolean; slots: number; used: number; wishes: number; free: number };
type Player = { userId: number; igns: string[]; access: boolean; room: { seasonal: Room; nonseasonal: Room }; rules: Rule[] };

function slotsText(r: Rule): string {
  if (r.slotsExact !== null) return `exactly ${r.slotsExact} slot${r.slotsExact === 1 ? "" : "s"}`;
  return `${r.slotsMin}+ slot${r.slotsMin === 1 ? "" : "s"}`;
}

function termText(t: MatchTerm): string {
  return t.kind === "ench" ? t.name : effectLabel(t.key);
}

function specText(spec: SlotSpec): string {
  if (!spec.any.length) return "any";
  return spec.any.map((row) => row.all.map(termText).join(" + ")).join(" or ");
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const roomText = (r: Room) => `${r.free} of ${r.slots} free · ${r.used} item${r.used === 1 ? "" : "s"}, ${r.wishes} wish${r.wishes === 1 ? "" : "es"}`;

export default function WishlistsTab({ password }: { password: string }) {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/wishlists", { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setPlayers((data.players ?? []) as Player[]);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  const q = filter.trim().toLowerCase();
  const shown = (players ?? []).filter((p) => !q || p.igns.some((i) => i.toLowerCase().includes(q)) || p.rules.some((r) => r.itemName.toLowerCase().includes(q)));
  const total = (players ?? []).reduce((n, p) => n + p.rules.length, 0);

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 640 }}>
        Every standing claim, by account. A wish watches one pool and is spent the moment it claims; the oldest wish across all players is served first. Wishes of an account without the feature stay listed but are never served.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <input
          placeholder="Filter by IGN or item"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", width: 220 }}
        />
        <button className="nav-link" onClick={() => void load()}>
          refresh
        </button>
        {players && (
          <span style={{ color: "var(--muted, #999)", fontSize: 13 }}>
            {total} wish{total === 1 ? "" : "es"} across {players.length} account{players.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      {players === null ? (
        <p>Loading…</p>
      ) : shown.length === 0 ? (
        <p style={{ color: "var(--muted, #999)" }}>{players.length === 0 ? "Nobody has wished for anything yet." : "No wishes match that filter."}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 820 }}>
          {shown.map((p) => (
            <div key={p.userId} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", background: "var(--panel)" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontWeight: 600, display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                  {p.igns.map((ign) => (
                    <PlayerName key={ign} ign={ign} readable />
                  ))}
                </span>
                {!p.access && <span style={{ color: "var(--bad)", fontSize: 12 }}>no wishlist access — wishes dormant</span>}
              </div>
              <div style={{ color: "var(--muted, #999)", fontSize: 12, marginBottom: 8 }}>
                seasonal vault: {roomText(p.room.seasonal)} · non-seasonal vault: {roomText(p.room.nonseasonal)}
              </div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--muted, #999)", fontSize: 12 }}>
                    <th style={{ padding: "4px 10px 4px 0" }}>Item</th>
                    <th style={{ padding: "4px 10px 4px 0" }}>Pool</th>
                    <th style={{ padding: "4px 10px 4px 0" }}>Slots</th>
                    <th style={{ padding: "4px 10px 4px 0" }}>Enchantments</th>
                    <th style={{ padding: "4px 0" }}>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {p.rules.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--border)", opacity: r.enabled ? 1 : 0.55 }}>
                      <td style={{ padding: "6px 10px 6px 0", whiteSpace: "nowrap" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <ItemSprite name={r.itemName} size={22} />
                          {r.itemName}
                        </span>
                      </td>
                      <td style={{ padding: "6px 10px 6px 0", whiteSpace: "nowrap" }}>{r.seasonal ? "seasonal" : "non-seasonal"}</td>
                      <td style={{ padding: "6px 10px 6px 0", whiteSpace: "nowrap" }}>{slotsText(r)}</td>
                      <td style={{ padding: "6px 10px 6px 0", fontSize: 13 }}>
                        {r.enchants.length === 0 ? <span style={{ color: "var(--muted, #999)" }}>any</span> : r.enchants.map((spec, i) => (
                          <div key={i}>
                            <span style={{ color: "var(--muted, #999)" }}>{i + 1}:</span> {specText(spec)}
                          </div>
                        ))}
                      </td>
                      <td style={{ padding: "6px 0", whiteSpace: "nowrap" }} title={new Date(r.createdAt).toLocaleString()}>
                        {ago(r.createdAt)}
                        {!r.enabled && " · paused"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
