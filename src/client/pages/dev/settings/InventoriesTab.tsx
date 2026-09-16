
import { useCallback, useEffect, useRef, useState } from "react";
import PlayerName from "@/components/PlayerName";

// Live inventories of every online bot, plus the contents of any open trade
// window. Polls /api/dev/inventories, which proxies pyrelay's /inventories.
//
// Speed comes from not doing work, in four places:
//
//   1. pyrelay describes only ONLINE bots (at most MAX_ONLINE_BOTS) instead of
//      the whole fleet, and projects them under one lock take.
//   2. Every response carries a `rev`. We send it back as `?since=` and an
//      unchanged fleet answers `{unchanged:true}` — we then return early
//      WITHOUT calling any setState, so React does not re-render at all. A
//      quiet fleet costs one small request per interval and nothing else.
//   3. One poll is in flight at a time (`busy`), and the timer is cleared while
//      the tab is hidden, so a backgrounded console stops polling entirely.
//   4. Sprites are fetched ONCE per Realm item id and cached for the life of
//      the tab. The poll response carries ids, never artwork — inlining base64
//      would put a few hundred KB on every tick that anything moved, which is
//      the exact cost point 2 exists to avoid.

type Item = {
  id: string;
  qty: number;
  name: string;
  category: string | null;
  realmId: number | null;
};

type TradeItem = {
  slot: number;
  realmId: number;
  tradeable: boolean;
  enchantment: string;
  offered: boolean;
};

type Trade = {
  ign: string;
  phase: string;
  items: TradeItem[];
};

type Bot = {
  guid: string;
  alias: string;
  ign: string;
  server: string;
  seasonal: boolean;
  assigned: string | null;
  partner: string | null;
  inWorld: boolean;
  // A maintenance routine (backpack chore, daily login) driving this bot: its current step, shown instead of the trade status.
  activity?: string | null;
  // Login-queue position for a popular realm (USEast etc.); -1 = not queued.
  queuePos: number;
  capacity: number;
  held: number;
  free: number;
  verifiedAt: number | null;
  items: Item[];
  trade: Trade | null;
};

type Sprite = { name: string; sprite: string | null };

const POLL_MS = 1500;
// Matches MAX_IDS in /api/dev/item-sprites. Batching beyond that is silently
// truncated server-side, so the client must not ask for more in one go.
const SPRITE_BATCH = 200;

// Assignment kind -> how it reads in the UI. Consolidation is the pair of
// internal potion moves; the rest are player work.
const ASSIGNMENT_LABEL: Record<string, string> = {
  deposit: "deposit",
  withdraw: "withdraw",
  consolidate_give: "consolidating →",
  consolidate_take: "consolidating ←",
};

// Trade phase -> what it means for the window on screen. Mirrors _State.phase
// in CommunismTradeFulfillPlugin; only phases with a filled snapshot reach us.
const PHASE_LABEL: Record<string, string> = {
  IN_TRADE: "window open",
  OFFERED: "our offer up",
  ACCEPTED: "accepted, awaiting partner",
};

function statusOf(bot: Bot): { text: string; color: string } {
  if (bot.activity) return { text: bot.activity, color: "var(--accent)" };
  if (bot.assigned) {
    const label = ASSIGNMENT_LABEL[bot.assigned] ?? bot.assigned;
    return {
      text: bot.partner ? `${label} · ${bot.partner}` : label,
      color: "var(--accent)",
    };
  }
  // Connected but no character yet: a login queue or a nexus load. Worth
  // distinguishing from idle — an idle bot can take work, this one can't.
  // Surface the login-queue place when we have one (USEast especially).
  if (!bot.inWorld) {
    if (typeof bot.queuePos === "number" && bot.queuePos > 0)
      return { text: `in queue · #${bot.queuePos}`, color: "var(--accent)" };
    return { text: "loading…", color: "var(--muted)" };
  }
  return { text: "idle", color: "var(--good)" };
}

function ago(epochSeconds: number | null): string {
  if (!epochSeconds) return "never";
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Short stand-in drawn in a slot whose artwork we don't have (yet, or at
 *  all). Initials beat a blank square — a bot full of unknown ids should
 *  still show that the slots differ. */
function initials(name: string): string {
  return name
    .replace(/^[#]/, "")
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}

/** One inventory/trade slot. */
function Slot({
  sprite,
  name,
  title,
  className = "",
  badge,
}: {
  sprite: string | null;
  name: string;
  title: string;
  className?: string;
  badge?: string;
}) {
  return (
    <div className={`inv-slot ${className}`} title={title}>
      {sprite ? (
        <img src={sprite} alt={name} />
      ) : (
        <span className="inv-slot-fallback">{initials(name)}</span>
      )}
      {badge && <span className="inv-slot-badge">{badge}</span>}
    </div>
  );
}

export default function InventoriesTab({ password }: { password: string }) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [error, setError] = useState("");
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");

  // Refs, not state: changing these must never trigger a render. `rev` is the
  // change token we hand back to the server, and `busy` keeps one poll in
  // flight at a time so a slow response can't stack up a queue behind it.
  const rev = useRef<string>("");
  const busy = useRef(false);

  // Realm item id -> artwork. A ref because it is a cache, not view state:
  // writing to it must not itself cause a render. `spriteTick` is bumped only
  // when a fetch actually ADDS something, which is the one moment the already
  // rendered grids need to be redrawn.
  const sprites = useRef<Map<number, Sprite>>(new Map());
  const spriteInflight = useRef<Set<number>>(new Set());
  const [spriteTick, setSpriteTick] = useState(0);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const qs = rev.current ? `?since=${encodeURIComponent(rev.current)}` : "";
      const res = await fetch(`/api/dev/inventories${qs}`, {
        headers: { "X-Dev-Password": password },
        cache: "no-store",
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      rev.current = body.rev ?? "";
      // The hot path on a quiet fleet: nothing moved, so touch no state.
      if (body.unchanged) {
        setError((e) => (e ? "" : e));
        return;
      }
      setBots(body.bots ?? []);
      setCapturedAt(body.capturedAt ?? null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [password]);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    // Fire immediately so switching to the tab isn't a blank interval wait.
    void poll();
    const id = setInterval(() => {
      // A hidden tab still runs timers (throttled). Skip the work outright so a
      // console left open in a background tab isn't polling pyrelay forever.
      if (!stopped && document.visibilityState === "visible") void poll();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [poll, paused]);

  // Fetch artwork for any id we've just seen for the first time.
  //
  // Runs on every `bots` change but is a no-op unless the fleet picked up an
  // item type we've never drawn — which, after the first few seconds, is only
  // when a trade window opens on a player carrying something new. Misses are
  // cached too (the endpoint answers unknown ids explicitly), so a sprite the
  // asset file lacks is asked for once rather than every poll.
  useEffect(() => {
    if (!bots) return;
    const missing: number[] = [];
    const want = (id: number | null) => {
      if (id === null || id < 0) return;
      if (sprites.current.has(id) || spriteInflight.current.has(id)) return;
      spriteInflight.current.add(id);
      missing.push(id);
    };
    for (const b of bots) {
      for (const it of b.items) want(it.realmId);
      for (const it of b.trade?.items ?? []) want(it.realmId);
    }
    if (missing.length === 0) return;

    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length; i += SPRITE_BATCH) {
        const batch = missing.slice(i, i + SPRITE_BATCH);
        try {
          const res = await fetch(
            `/api/dev/item-sprites?ids=${batch.join(",")}`,
            { headers: { "X-Dev-Password": password } },
          );
          const body = await res.json();
          if (cancelled) return;
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          for (const [id, v] of Object.entries(body.items ?? {})) {
            sprites.current.set(Number(id), v as Sprite);
          }
          setSpriteTick((n) => n + 1);
        } catch {
          // Leave these ids uncached so a later poll retries them. The grid
          // keeps rendering initials meanwhile — a sprite outage should cost
          // artwork, not the tab.
        } finally {
          for (const id of batch) spriteInflight.current.delete(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bots, password]);

  const spriteFor = useCallback(
    (realmId: number | null, fallbackName: string): Sprite => {
      if (realmId === null) return { name: fallbackName, sprite: null };
      return (
        sprites.current.get(realmId) ?? { name: fallbackName, sprite: null }
      );
    },
    // spriteTick is the dependency that matters: the Map is mutated in place,
    // so this callback must be re-created when its contents change or the
    // memoized grids below would keep drawing the pre-fetch view.
    [spriteTick],
  );

  const q = filter.trim().toLowerCase();
  const shown = (bots ?? []).filter((b) => {
    if (!q) return true;
    if (
      b.alias.toLowerCase().includes(q) ||
      b.ign.toLowerCase().includes(q) ||
      b.server.toLowerCase().includes(q) ||
      b.items.some((i) => i.name.toLowerCase().includes(q))
    ) {
      return true;
    }
    // Trade partners are searchable too — "who is this bot trading with" is
    // the reason to open this tab during an incident.
    const t = b.trade;
    if (!t) return false;
    return (
      t.ign.toLowerCase().includes(q) ||
      t.items.some((i) =>
        spriteFor(i.realmId, "").name.toLowerCase().includes(q),
      )
    );
  });

  const totalItems = (bots ?? []).reduce((n, b) => n + b.held, 0);
  const totalFree = (bots ?? []).reduce((n, b) => n + b.free, 0);
  const trading = (bots ?? []).filter((b) => b.trade).length;

  return (
    <section>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <input
          placeholder="filter by bot, ign, server, item or trade partner…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            padding: "8px 10px",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            minWidth: 260,
            flex: "1 1 260px",
          }}
        />
        <button
          className="nav-link"
          onClick={() => setPaused((p) => !p)}
          title={paused ? "Resume live updates" : "Stop polling pyrelay"}
        >
          {paused ? "▶ resume" : "⏸ pause"}
        </button>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {bots === null
            ? "loading…"
            : `${bots.length} online · ${totalItems} items · ${totalFree} free slots` +
              (trading ? ` · ${trading} trading` : "")}
          {capturedAt && !paused ? ` · updated ${ago(capturedAt)}` : ""}
        </span>
      </div>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      {bots !== null && bots.length === 0 && (
        <p style={{ color: "var(--muted)" }}>
          No bots online. The fleet&apos;s resting state is offline — the
          dispatcher wakes bots when work appears.
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 12,
        }}
      >
        {shown.map((bot) => {
          const status = statusOf(bot);

          // One tile per SLOT, not per stack. Realm inventories don't stack,
          // so pyrelay's qty is a slot count and expanding it reproduces the
          // bags as the bot actually holds them — then pad to capacity so the
          // free space is visible rather than inferred from a number.
          const slots: { key: string; item: Item }[] = [];
          for (const item of bot.items) {
            for (let i = 0; i < item.qty; i++) {
              slots.push({ key: `${item.id}-${i}`, item });
            }
          }
          const empties = Math.max(0, bot.capacity - slots.length);

          return (
            <div
              key={bot.guid}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                }}
              >
                <strong style={{ fontSize: 14 }}>{bot.ign || bot.alias}</strong>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>
                  {bot.server || "—"}
                </span>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  margin: "6px 0 10px",
                  fontSize: 12,
                }}
              >
                <span style={{ color: status.color }}>{status.text}</span>
                <span style={{ color: "var(--muted)" }}>
                  {bot.held}/{bot.capacity} slots
                </span>
                {!bot.seasonal && (
                  <span style={{ color: "var(--muted)" }}>non-seasonal</span>
                )}
              </div>

              <div className="inv-grid">
                {slots.map(({ key, item }) => {
                  const s = spriteFor(item.realmId, item.name);
                  return (
                    <Slot
                      key={key}
                      sprite={s.sprite}
                      name={item.name}
                      title={`${item.name}${
                        item.category ? ` · ${item.category}` : ""
                      }`}
                    />
                  );
                })}
                {Array.from({ length: empties }, (_, i) => (
                  <div key={`empty-${i}`} className="inv-slot empty" />
                ))}
              </div>

              {bot.trade && (
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 8,
                      marginBottom: 6,
                      fontSize: 12,
                    }}
                  >
                    <span>
                      <span style={{ color: "var(--muted)" }}>trading with </span>
                      <strong>
                        {bot.trade.ign ? <PlayerName ign={bot.trade.ign} readable /> : "—"}
                      </strong>
                    </span>
                    <span style={{ color: "var(--muted)" }}>
                      {PHASE_LABEL[bot.trade.phase] ?? bot.trade.phase}
                    </span>
                  </div>

                  {bot.trade.items.length === 0 ? (
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>
                      their window is empty
                    </div>
                  ) : (
                    <div className="inv-grid">
                      {bot.trade.items.map((it) => {
                        const s = spriteFor(it.realmId, `#${it.realmId}`);
                        const cls = [
                          it.offered ? "offered" : "",
                          it.tradeable ? "" : "untradeable",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        const notes = [
                          it.offered ? "offered" : null,
                          it.tradeable ? null : "untradeable",
                          it.enchantment || null,
                        ].filter(Boolean);
                        return (
                          <Slot
                            key={it.slot}
                            sprite={s.sprite}
                            name={s.name}
                            className={cls}
                            title={
                              notes.length
                                ? `${s.name} · ${notes.join(" · ")}`
                                : s.name
                            }
                          />
                        );
                      })}
                    </div>
                  )}

                  <div
                    style={{
                      marginTop: 6,
                      color: "var(--muted)",
                      fontSize: 11,
                    }}
                  >
                    their whole window · gold border = put up for trade
                  </div>
                </div>
              )}

              <div
                style={{
                  marginTop: 8,
                  color: "var(--muted)",
                  fontSize: 11,
                }}
                title="When pyrelay last verified this bot's bags against a live client"
              >
                verified {ago(bot.verifiedAt)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
