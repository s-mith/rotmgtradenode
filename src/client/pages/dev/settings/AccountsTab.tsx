
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
// Sprites are fetched in batches of ids so a big lookup costs a few requests.
const SPRITE_BATCH = 200;

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

  // Add-account form (design doc §4.1: the roster is the owner's own alts).
  const [addEmail, setAddEmail] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addSeasonal, setAddSeasonal] = useState(true);
  const [addWalked, setAddWalked] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  const addAccount = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setAddBusy(true);
    setAddMsg(null);
    try {
      const res = await fetch("/api/dev/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ email: addEmail.trim(), password: addPassword, seasonal: addSeasonal, tutorialDone: addWalked }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setAddMsg({ ok: true, text: body.where === "roster" ? `${addEmail.trim()} is on the roster; the fleet may log it in now.` : `${addEmail.trim()} queued for its tutorial walk — watch the Tutorials tab; it joins the roster when done.` });
      setAddEmail("");
      setAddPassword("");
      void search(lastQuery.current);
    } catch (err) {
      setAddMsg({ ok: false, text: err instanceof Error ? err.message : "could not add the account" });
    } finally {
      setAddBusy(false);
    }
  }, [addEmail, addPassword, addSeasonal, addWalked, password, search]);

  const spriteFor = useCallback(
    (realmId: number | null): string | null =>
      realmId === null ? null : sprites.current.get(realmId)?.sprite ?? null,
    // The Map is mutated in place, so this must be re-created when its
    // contents change or the rows would keep drawing the pre-fetch view.
    [spriteTick],
  );

  return (
    <div>
      <form onSubmit={(e) => void addAccount(e)} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Add one of your accounts</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 10px", maxWidth: 640 }}>
          Your own alt, made on Realm&apos;s site. If it has never played, leave &ldquo;tutorial done&rdquo; off and the node walks the
          tutorial for it. Credentials stay in this node&apos;s data folder and go nowhere else.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="email" autoComplete="off" style={{ width: 220 }} />
          <input value={addPassword} onChange={(e) => setAddPassword(e.target.value)} placeholder="password" type="password" autoComplete="new-password" style={{ width: 180 }} />
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={addSeasonal} onChange={(e) => setAddSeasonal(e.target.checked)} /> seasonal
          </label>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={addWalked} onChange={(e) => setAddWalked(e.target.checked)} /> tutorial done
          </label>
          <button className="nav-link" type="submit" disabled={addBusy || !addEmail.trim() || !addPassword}>
            {addBusy ? "…" : "add"}
          </button>
        </div>
        {addMsg && <p style={{ color: addMsg.ok ? "var(--good, #5aa86a)" : "var(--bad)", fontSize: 12, margin: "8px 0 0" }}>{addMsg.text}</p>}
      </form>

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
