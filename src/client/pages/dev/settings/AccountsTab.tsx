
import { useCallback, useEffect, useRef, useState } from "react";

// Account lookup: find ANY bot account and see what's on it.
//
// The gap this fills: the Inventories tab shows only bots that are ONLINE, and
// offline is the normal state for most of the fleet. /api/pool covers every bot
// but hides suspended accounts, because everything it lists has to be
// withdrawable. So an item parked on an offline or retired bot was invisible in
// the console — which is exactly the item someone comes here looking for.
//
// Search-driven rather than polled, for the same reason: this answers "where is
// X" on demand, so it costs one request per search instead of a timer. The
// picture it shows is pyrelay's last capture, and every card says how old that
// is, because for an offline bot that's the difference between fact and memory.

type Item = {
  slot: number;
  instanceId: string;
  itemId: string;
  name: string;
  known: boolean;
  category: string | null;
  realmId: number | null;
  enchantments: number[];
  enchantNames: (string | null)[];
  capturedAt: number | null;
};

type Account = {
  alias: string;
  guid: string;
  botGuid: string;
  ign: string;
  server: string;
  online: boolean;
  inWorld: boolean;
  seasonal: boolean | null;
  suspended: boolean;
  inUse: boolean;
  assignedKind: string | null;
  assignedRequestId: number | null;
  capacity: number;
  held: number;
  lastSeen: number | null;
  items: Item[];
};

type Sprite = { name: string; sprite: string | null };

// Progress of a fleet-wide ban sweep. Mirrors lib/devauth.ts's BanSweep, which
// mirrors pyrelay's Communism/BanSweep.py. The last three are absent on older
// pyrelay builds, so everything that reads them tolerates undefined.
type Sweep = {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  total: number;
  checked: number;
  healthy: number;
  unknown: number;
  skippedOnline: number;
  skippedLocked: number;
  skippedArchived: number;
  banned: { alias: string; guid: string; botGuid: string }[];
  stoppedReason: string | null;
  current: string | null;
  phase?: "draining" | "sweeping" | null;
  tradesHeld?: boolean;
  concurrency?: number;
};

// How often to poll while a sweep runs. It logs a handful of accounts in at a
// time, each taking seconds, so a 2s poll never misses a step and costs
// almost nothing.
const SWEEP_POLL_MS = 2000;

// Matches MAX_IDS in /api/dev/item-sprites.
const SPRITE_BATCH = 200;

function relTime(ts: number | null): string {
  if (ts === null) return "never seen";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Status line for the card header. Ordered by what an operator needs to know
// first: a suspended account explains a missing item outright, so it outranks
// everything else on the card.
function statusOf(a: Account): { text: string; color: string } {
  if (a.suspended) return { text: "SUSPENDED", color: "var(--bad)" };
  if (!a.online) return { text: "offline", color: "var(--muted)" };
  if (!a.inWorld) return { text: "connecting", color: "var(--warn, #d2a24c)" };
  if (a.assignedKind) {
    const req = a.assignedRequestId === null ? "" : ` #${a.assignedRequestId}`;
    return { text: `${a.assignedKind}${req}`, color: "var(--warn, #d2a24c)" };
  }
  if (a.inUse) return { text: "reserved", color: "var(--warn, #d2a24c)" };
  return { text: "idle", color: "var(--good, #5aa86a)" };
}

export default function AccountsTab({ password }: { password: string }) {
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [sweepErr, setSweepErr] = useState<string | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);

  const sprites = useRef<Map<number, Sprite>>(new Map());
  const spriteInflight = useRef<Set<number>>(new Set());
  const [spriteTick, setSpriteTick] = useState(0);

  // A run counter, not an AbortController: the point isn't to cancel the
  // request but to ignore a slow one that lands after a newer search. Without
  // it, typing "kap" then "kappa12" can leave the "kap" results on screen.
  const runId = useRef(0);
  // What the visible cards are a result of — `query` is the input box, which
  // the operator may have edited since. A refresh has to repeat the search
  // that produced what's on screen.
  const lastQuery = useRef("");

  const search = useCallback(
    async (q: string) => {
      const mine = ++runId.current;
      lastQuery.current = q;
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch(
          `/api/dev/account-lookup?q=${encodeURIComponent(q)}`,
          { headers: { "X-Dev-Password": password } },
        );
        const body = await res.json();
        if (mine !== runId.current) return;
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setAccounts(body.accounts ?? []);
        setTotal(body.total ?? 0);
      } catch (e) {
        if (mine !== runId.current) return;
        setErr(e instanceof Error ? e.message : "lookup failed");
        setAccounts([]);
        setTotal(0);
      } finally {
        if (mine === runId.current) setBusy(false);
      }
    },
    [password],
  );

  // Open with the head of the fleet so the tab isn't a blank box.
  useEffect(() => {
    void search("");
  }, [search]);

  // Sprites are fetched once per realm id and kept for the life of the tab —
  // same cache discipline as the Inventories tab. A failed batch is left
  // uncached so a later search retries it; the rows render initials meanwhile,
  // because a sprite outage should cost artwork, not the tab.
  useEffect(() => {
    if (!accounts) return;
    const missing: number[] = [];
    for (const a of accounts) {
      for (const it of a.items) {
        const id = it.realmId;
        if (id === null) continue;
        if (sprites.current.has(id) || spriteInflight.current.has(id)) continue;
        spriteInflight.current.add(id);
        missing.push(id);
      }
    }
    if (missing.length === 0) return;

    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length; i += SPRITE_BATCH) {
        const batch = missing.slice(i, i + SPRITE_BATCH);
        try {
          const res = await fetch(`/api/dev/item-sprites?ids=${batch.join(",")}`, {
            headers: { "X-Dev-Password": password },
          });
          const body = await res.json();
          if (cancelled) return;
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          for (const [id, v] of Object.entries(body.items ?? {})) {
            sprites.current.set(Number(id), v as Sprite);
          }
          setSpriteTick((n) => n + 1);
        } catch {
          // leave uncached; a later search retries
        } finally {
          for (const id of batch) spriteInflight.current.delete(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts, password]);

  // --- ban sweep ----------------------------------------------------------
  // Log every account in and archive the ones Realm says are banned. pyrelay
  // runs the same routine its boot sweep uses, so the accounts that come up
  // clean also get their inventories refreshed on the way past.
  //
  // It takes minutes (a handful of logins at a time — a burst is what trips
  // Realm's rate limit and costs each refused account a 5-minute lockout) and
  // it pauses withdraws and deposits for the whole run, so this starts it and
  // polls rather than holding a request open.

  const pollSweep = useCallback(async () => {
    try {
      const res = await fetch("/api/dev/ban-sweep", {
        headers: { "X-Dev-Password": password },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSweep(body.sweep as Sweep);
      return body.sweep as Sweep;
    } catch (e) {
      setSweepErr(e instanceof Error ? e.message : "sweep status failed");
      return null;
    }
  }, [password]);

  // Pick up a sweep that is already running — started from another browser, or
  // before this tab was opened. Without this, reloading the page mid-sweep
  // looks like nothing is happening and invites a second click.
  useEffect(() => {
    void pollSweep();
  }, [pollSweep]);

  // Poll only while one is in flight; the final snapshot stays on screen.
  useEffect(() => {
    if (!sweep?.running) return;
    const id = setInterval(() => void pollSweep(), SWEEP_POLL_MS);
    return () => clearInterval(id);
  }, [sweep?.running, pollSweep]);

  // A finished sweep changes what the cards below should say — an archived
  // account reads SUSPENDED, and that is the whole point of having run it. The
  // list is search-driven and wouldn't otherwise refetch, so a sweep that just
  // retired two bots would leave them on screen looking healthy.
  const sweepWasRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(sweep?.running);
    if (sweepWasRunning.current && !running) void search(lastQuery.current);
    sweepWasRunning.current = running;
  }, [sweep?.running, search]);

  const startSweep = useCallback(async () => {
    if (
      !confirm(
        "Log every bot account in to check it against Realm?\n\n" +
          "WITHDRAWS AND DEPOSITS ARE PAUSED for the whole run. Trades " +
          "already in progress finish first; new requests queue up and are " +
          "served when the sweep ends.\n\n" +
          "Each account is a real login, so this runs slowly in the " +
          "background (minutes, not seconds) and skips bots that are online " +
          "or rate-limited. Accounts that come up clean get their tracked " +
          "inventory refreshed. Anything Realm reports SUSPENDED is " +
          "archived: flagged in Accounts.json and dropped from the pool. " +
          "Items on an archived bot stay recorded but become unreachable.",
      )
    ) {
      return;
    }
    setSweepBusy(true);
    setSweepErr(null);
    try {
      const res = await fetch("/api/dev/ban-sweep", {
        method: "POST",
        headers: { "X-Dev-Password": password },
      });
      const body = await res.json();
      // 409 means one was already running — that's the state the operator
      // wanted anyway, so fall through to polling rather than erroring.
      if (!res.ok && res.status !== 409) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await pollSweep();
    } catch (e) {
      setSweepErr(e instanceof Error ? e.message : "could not start the sweep");
    } finally {
      setSweepBusy(false);
    }
  }, [password, pollSweep]);

  const cancelSweep = useCallback(async () => {
    setSweepBusy(true);
    try {
      const res = await fetch("/api/dev/ban-sweep", {
        method: "DELETE",
        headers: { "X-Dev-Password": password },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSweep(body.sweep as Sweep);
    } catch (e) {
      setSweepErr(e instanceof Error ? e.message : "could not stop the sweep");
    } finally {
      setSweepBusy(false);
    }
  }, [password]);

  const spriteFor = useCallback(
    (realmId: number | null): string | null =>
      realmId === null ? null : sprites.current.get(realmId)?.sprite ?? null,
    // The Map is mutated in place, so this must be re-created when its
    // contents change or the rows would keep drawing the pre-fetch view.
    [spriteTick],
  );

  // A finished sweep that found nothing still deserves a line — "0 banned" is
  // the answer the operator came for, and a panel that empties itself reads
  // like the sweep failed.
  const sweepDone = sweep !== null && !sweep.running && sweep.finishedAt !== null;

  return (
    <div>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            className="nav-link"
            type="button"
            onClick={() => void startSweep()}
            disabled={sweepBusy || Boolean(sweep?.running)}
          >
            {sweep?.running ? "checking…" : "check every account for bans"}
          </button>
          {sweep?.running && (
            <button
              className="nav-link"
              type="button"
              onClick={() => void cancelSweep()}
              disabled={sweepBusy}
            >
              stop
            </button>
          )}
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            {sweep?.running
              ? sweep.phase === "draining"
                ? "waiting for trades in progress to finish…"
                : `${sweep.checked}/${sweep.total} logged in` +
                  (sweep.current ? ` · on ${sweep.current}` : "")
              : "logs every account in; archives the banned ones and refreshes the rest"}
          </span>
        </div>

        {/* The pause is the part with a blast radius, so it gets its own line
            rather than a clause in the counters below. Only rendered when
            pyrelay actually reports the hold — an older build's sweep doesn't
            take one, and claiming it does would be worse than saying nothing. */}
        {sweep?.running && sweep.tradesHeld && (
          <p style={{ color: "var(--warn, #d2a24c)", fontSize: 12, margin: "8px 0 0" }}>
            withdraws and deposits are paused — player requests are queueing and
            will be served as soon as this finishes
          </p>
        )}

        {sweepErr && (
          <p style={{ color: "var(--bad)", fontSize: 12, margin: "8px 0 0" }}>{sweepErr}</p>
        )}

        {sweep !== null && (sweep.running || sweepDone) && (
          <div style={{ fontSize: 12, marginTop: 8 }}>
            <p style={{ color: "var(--muted)", margin: 0 }}>
              {sweep.checked} logged in · {sweep.healthy} fine · {sweep.banned.length} banned
              {sweep.unknown > 0 && ` · ${sweep.unknown} inconclusive`}
              {sweep.skippedOnline > 0 && ` · ${sweep.skippedOnline} online (skipped)`}
              {sweep.skippedLocked > 0 && ` · ${sweep.skippedLocked} rate-limited (skipped)`}
              {sweep.skippedArchived > 0 && ` · ${sweep.skippedArchived} already archived`}
            </p>
            {sweep.stoppedReason && (
              <p style={{ color: "var(--warn, #d2a24c)", margin: "4px 0 0" }}>
                stopped early — {sweep.stoppedReason}. The accounts it never
                reached are unchanged; run it again to finish them.
              </p>
            )}
            {sweep.banned.length > 0 ? (
              <div style={{ marginTop: 6 }}>
                <strong style={{ color: "var(--bad)" }}>
                  archived {sweep.banned.length} banned account
                  {sweep.banned.length === 1 ? "" : "s"}:
                </strong>{" "}
                <span style={{ color: "var(--muted)" }}>
                  {sweep.banned.map((b) => b.alias).join(", ")}
                </span>
              </div>
            ) : (
              sweepDone && (
                <p style={{ color: "var(--good, #5aa86a)", margin: "4px 0 0" }}>
                  no new bans found
                  {sweep.healthy > 0 &&
                    ` — ${sweep.healthy} inventor${
                      sweep.healthy === 1 ? "y" : "ies"
                    } refreshed`}
                </p>
              )
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search(query);
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="alias, guid or in-game name — blank lists the fleet"
          style={{ flex: 1 }}
          autoComplete="off"
        />
        <button className="nav-link" type="submit" disabled={busy}>
          {busy ? "…" : "look up"}
        </button>
      </form>

      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}

      {accounts !== null && (
        <p style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
          {total === 0
            ? "no accounts match"
            : `${total} match${total === 1 ? "" : "es"}${
                accounts.length < total ? ` — showing first ${accounts.length}` : ""
              }`}
        </p>
      )}

      {accounts?.map((a) => {
        const st = statusOf(a);
        return (
          <div
            key={a.botGuid}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
              // A retired account is the answer to most searches that reach
              // this tab, so it gets a visual edge rather than one word in a
              // status line.
              opacity: a.suspended ? 0.75 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <strong>{a.alias}</strong>
              {a.ign && a.ign !== a.alias && (
                <span style={{ color: "var(--muted)" }}>· {a.ign}</span>
              )}
              <span style={{ color: st.color, fontWeight: 600 }}>{st.text}</span>
              {a.server && <span style={{ color: "var(--muted)" }}>· {a.server}</span>}
              <span style={{ color: "var(--muted)" }}>
                ·{" "}
                {a.seasonal === null
                  ? "season unknown"
                  : a.seasonal
                    ? "seasonal"
                    : "non-seasonal"}
              </span>
            </div>

            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
              {a.held}/{a.capacity} slots · captured {relTime(a.lastSeen)}
              {!a.online && a.lastSeen !== null && " (last known — bot is offline)"}
              <span title={a.guid}> · {a.botGuid.slice(0, 12)}…</span>
            </div>

            {a.items.length === 0 ? (
              <p style={{ color: "var(--muted)", marginTop: 10, marginBottom: 0 }}>
                {a.lastSeen === null
                  ? "never swept — pyrelay has no record of this account's inventory"
                  : "empty"}
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
                {a.items.map((it) => {
                  const sprite = spriteFor(it.realmId);
                  return (
                    <li
                      key={it.instanceId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "3px 0",
                      }}
                    >
                      <span style={{ color: "var(--muted)", fontSize: 11, width: 22 }}>
                        {it.slot}
                      </span>
                      {sprite ? (
                        <img
                          src={sprite}
                          alt=""
                          width={24}
                          height={24}
                          style={{ imageRendering: "pixelated" }}
                        />
                      ) : (
                        <span
                          style={{
                            width: 24,
                            textAlign: "center",
                            color: "var(--muted)",
                            fontSize: 11,
                          }}
                        >
                          {it.name.slice(0, 3)}
                        </span>
                      )}
                      <span title={it.itemId}>{it.name}</span>
                      {!it.known && (
                        <span
                          style={{ color: "var(--muted)", fontSize: 11 }}
                          title="pyrelay tracks whatever the bot physically holds; this site doesn't trade it"
                        >
                          (not in catalog)
                        </span>
                      )}
                      {it.enchantments.length > 0 && (
                        <span
                          style={{ color: "var(--muted)", fontSize: 11 }}
                          title={it.enchantNames.filter(Boolean).join(", ")}
                        >
                          +{it.enchantments.length}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
