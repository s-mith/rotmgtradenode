
import { useEffect, useState } from "react";
import InventoriesTab from "./InventoriesTab";
import DepositsTab from "./DepositsTab";
import CosmeticsTab from "./CosmeticsTab";
import AccountsTab from "./AccountsTab";
import BackpacksTab from "./BackpacksTab";
import ItemPointsTab from "./ItemPointsTab";
import LeaderboardTab from "./LeaderboardTab";
import ServerControlTab from "./ServerControlTab";
import ProxiesTab from "./ProxiesTab";
import TutorialsTab from "./TutorialsTab";
import NamedAccountTab from "./NamedAccountTab";
import BlogTab from "./BlogTab";
import SkinsTab from "./SkinsTab";
import FeaturesTab from "./FeaturesTab";
import WishlistsTab from "./WishlistsTab";
import VaultCapsTab from "./VaultCapsTab";
import TrafficTab from "./TrafficTab";
import PlayerName from "@/components/PlayerName";

// Dev — operator console. The account-creator console that used to live at
// /dev/accounts is gone — account minting + tutorial now run in the
// standalone accountgen service (GET /account there hands out a finished
// account). Two tabs survive here:
//   Pool        — pool-wide knobs (legacy backpack switch, inert)
//   Rate limits — per-player withdraw caps (X items/day for Y days),
//                 stored in the website's SQLite and enforced by /api/withdraw.
//   Item points — what each item is worth to deposit, and whether the pool
//                 still accepts it. Publishing starts a new pricing cutoff so
//                 nobody's existing score moves (see lib/itemPricing.ts).
//   Cosmetics   — who may use donator name effects (see lib/cosmetics.ts).
//   Proxies     — the relay's exit-IP list, with a per-host on/off switch
//                 (see ProxiesTab.tsx).
//   Tutorials   — live view of the tutorial walks accountgen is running
//                 (minimap, stage, log per bot; see TutorialsTab.tsx).
//   Named acct  — mint one Realm account under a chosen name, tutorial not
//                 walked, credentials shown once (see NamedAccountTab.tsx).

const STORAGE_KEY = "dev_password";

type DevTab =
  | "pool"
  | "inventories"
  | "accounts"
  | "backpacks"
  | "deposits"
  | "itempoints"
  | "ratelimits"
  | "leaderboard"
  | "cosmetics"
  | "servercontrols"
  | "proxies"
  | "tutorials"
  | "namedaccount"
  | "blog"
  | "skins"
  | "features"
  | "wishlists"
  | "vaultcaps"
  | "traffic"
;

// The console is arranged as categories across the top and each category's
// tools down the left. A tool lives in exactly one category.
type DevCategory = "fleet" | "economy" | "players" | "content";
const CATEGORIES: { id: DevCategory; label: string; tabs: { id: DevTab; label: string }[] }[] = [
  {
    id: "fleet",
    label: "Fleet",
    tabs: [
      { id: "pool", label: "Pool" },
      { id: "inventories", label: "Inventories" },
      { id: "accounts", label: "Accounts" },
      { id: "backpacks", label: "Backpacks" },
      { id: "namedaccount", label: "Named account" },
      { id: "proxies", label: "Proxies" },
      { id: "tutorials", label: "Tutorials" },
      { id: "servercontrols", label: "Server controls" },
    ],
  },
  {
    id: "economy",
    label: "Economy",
    tabs: [
      { id: "deposits", label: "Deposits" },
      { id: "itempoints", label: "Item points" },
      { id: "leaderboard", label: "Leaderboard" },
    ],
  },
  {
    id: "players",
    label: "Players",
    tabs: [
      { id: "ratelimits", label: "Rate limits" },
      { id: "cosmetics", label: "Cosmetics" },
      { id: "features", label: "Feature access" },
      { id: "wishlists", label: "Wishlists" },
      { id: "vaultcaps", label: "Vault caps" },
      { id: "traffic", label: "Traffic" },
    ],
  },
  {
    id: "content",
    label: "Content",
    tabs: [
      { id: "blog", label: "Blog" },
      { id: "skins", label: "Skins" },
    ],
  },
];
const categoryOf = (tab: DevTab): DevCategory => CATEGORIES.find((c) => c.tabs.some((t) => t.id === tab))?.id ?? "fleet";
const TAB_KEY = "dev_tab";
function rememberedTab(): DevTab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v && CATEGORIES.some((c) => c.tabs.some((t) => t.id === v))) return v as DevTab;
  } catch {
    // Storage blocked: start on the first tool.
  }
  return "pool";
}

type LimitEntry = {
  ign: string;
  ignLower: string;
  itemsPerDay: number;
  expiresAt: number;
  usedToday: number;
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: 0,
  borderRadius: 6,
  color: "#000",
  fontWeight: 600,
  cursor: "pointer",
};

function daysLeft(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 1) return `${Math.ceil(days)}d left`;
  return `${Math.max(1, Math.ceil(ms / (60 * 60 * 1000)))}h left`;
}

export default function DevSettingsPage() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [tab, setTabState] = useState<DevTab>(rememberedTab);
  const setTab = (t: DevTab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      // Storage blocked: the pick just doesn't survive a reload.
    }
  };
  const category = categoryOf(tab);

  // Pool-wide backpack knob. INERT since 2026-09: the fleet sizes every bot
  // from its own evidence (HAS_BACKPACK stat or an item in a backpack slot);
  // the switch survives only so the settings file keeps its shape. (It used
  // to force every bot to 16 slots when the HAS_BACKPACK stat didn't
  // reliably arrive). null = not yet loaded from pyrelay.
  const [poolHasBackpack, setPoolHasBackpack] = useState<boolean | null>(null);
  const [savingBackpack, setSavingBackpack] = useState(false);

  // Rate-limit console state. null = not yet loaded.
  const [limits, setLimits] = useState<LimitEntry[] | null>(null);
  const [savingLimit, setSavingLimit] = useState(false);
  // Add form
  const [newIgn, setNewIgn] = useState("");
  const [newPerDay, setNewPerDay] = useState("4");
  const [newDays, setNewDays] = useState("7");
  // Row being edited inline (keyed by ignLower) and its draft values
  const [editing, setEditing] = useState<string | null>(null);
  const [editPerDay, setEditPerDay] = useState("");
  const [editDays, setEditDays] = useState("");

  // Restore saved password on first mount.
  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      setPassword(saved);
      tryLoad(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tryLoad(pw: string) {
    setLoading(true);
    setError("");
    try {
      // Auth against the rate-limits endpoint — it only needs DEV_PASSWORD
      // and the local DB, so the console stays usable when pyrelay is down.
      const r = await fetch("/api/dev/rate-limits", {
        headers: { "x-dev-password": pw },
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        setAuthed(false);
        return;
      }
      setLimits((data?.limits ?? []) as LimitEntry[]);
      setAuthed(true);
      sessionStorage.setItem(STORAGE_KEY, pw);
      // Pool settings proxy to pyrelay — load best-effort so a pyrelay
      // outage only degrades the Pool tab, not the whole console.
      loadPoolSettings(pw);
    } catch (e) {
      setError(String(e));
      setAuthed(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadPoolSettings(pw: string) {
    try {
      const r = await fetch("/api/dev/settings", {
        headers: { "x-dev-password": pw },
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      const s = (data?.settings ?? {}) as { pool_has_backpack?: boolean };
      setPoolHasBackpack(Boolean(s.pool_has_backpack));
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadLimits(pw: string) {
    try {
      const r = await fetch("/api/dev/rate-limits", {
        headers: { "x-dev-password": pw },
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setLimits((data?.limits ?? []) as LimitEntry[]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function togglePoolBackpack(next: boolean) {
    // Optimistic update so the checkbox feels instant; revert on error.
    const prev = poolHasBackpack;
    setPoolHasBackpack(next);
    setSavingBackpack(true);
    try {
      const r = await fetch("/api/dev/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ pool_has_backpack: next }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        setPoolHasBackpack(prev);
        return;
      }
      const s = (data?.settings ?? {}) as { pool_has_backpack?: boolean };
      // Trust the server's echo in case it normalised the value somehow.
      setPoolHasBackpack(Boolean(s.pool_has_backpack));
    } catch (e) {
      setError(String(e));
      setPoolHasBackpack(prev);
    } finally {
      setSavingBackpack(false);
    }
  }

  // One-shot: flag every account in the fleet non-seasonal. Confirmed first
  // because it rewrites pyrelay's Accounts.json for BOTH sites and there is
  // Shared by the add form and inline edit — POST upserts by IGN.
  async function saveLimit(ign: string, itemsPerDay: number, days: number): Promise<boolean> {
    setError("");
    setSavingLimit(true);
    try {
      const r = await fetch("/api/dev/rate-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ ign, itemsPerDay, days }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return false;
      }
      await loadLimits(password);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setSavingLimit(false);
    }
  }

  async function deleteLimit(ign: string) {
    setError("");
    setSavingLimit(true);
    try {
      const r = await fetch("/api/dev/rate-limits", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ ign }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      await loadLimits(password);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingLimit(false);
    }
  }

  async function submitNewLimit(e: React.FormEvent) {
    e.preventDefault();
    const perDay = Number(newPerDay);
    const days = Number(newDays);
    const ok = await saveLimit(newIgn.trim(), perDay, days);
    if (ok) {
      setNewIgn("");
    }
  }

  function startEdit(l: LimitEntry) {
    setEditing(l.ignLower);
    setEditPerDay(String(l.itemsPerDay));
    // Prefill with the remaining window rounded up so "save" without
    // touching the field roughly preserves the current expiry.
    setEditDays(String(Math.max(1, Math.ceil((l.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))));
  }

  async function submitEdit(l: LimitEntry) {
    const ok = await saveLimit(l.ign, Number(editPerDay), Number(editDays));
    if (ok) setEditing(null);
  }

  if (!authed) {
    return (
      <main>
        <h1 style={{ fontSize: 22, marginBottom: 16 }}>Dev — settings</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            tryLoad(password);
          }}
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <input
            type="password"
            placeholder="dev password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={{ ...inputStyle, width: 280 }}
          />
          <button type="submit" disabled={loading} style={buttonStyle}>
            {loading ? "…" : "Unlock"}
          </button>
        </form>
        {error && <p style={{ color: "var(--bad)", marginTop: 12 }}>{error}</p>}
      </main>
    );
  }

  return (
    <main>
      <header className="site">
        <span className="title-link" style={{ cursor: "default" }}>
          <img src="/logo.png" alt="" className="title-logo" width={48} height={48} />
          Dev — settings
        </span>
        <button className="nav-link" onClick={() => tryLoad(password)}>refresh</button>
        <button
          className="nav-link"
          onClick={() => {
            sessionStorage.removeItem(STORAGE_KEY);
            setAuthed(false);
            setPassword("");
          }}
        >
          lock
        </button>
      </header>

      <div className="pool-tabs">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={"nav-link" + (category === c.id ? " active" : "")}
            onClick={() => {
              if (category !== c.id) setTab(c.tabs[0].id);
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="dev-body">
        <nav className="dev-side" aria-label="Tools">
          {CATEGORIES.find((c) => c.id === category)?.tabs.map((t) => (
            <button
              key={t.id}
              className={"nav-link" + (tab === t.id ? " active" : "")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="dev-main">
      {error && (
        <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>
      )}

      {tab === "pool" && (
        <section>
          <label
            title="Legacy knob, now inert: capacity is per bot (16 slots once a backpack is seen on that character, else 8). Kept only so old deployments read a consistent settings file."
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              cursor: poolHasBackpack === null ? "wait" : "pointer",
              opacity: poolHasBackpack === null ? 0.5 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={poolHasBackpack === true}
              disabled={poolHasBackpack === null || savingBackpack}
              onChange={(e) => togglePoolBackpack(e.target.checked)}
            />
            All bots have backpacks <span style={{ color: "var(--muted, #999)", fontSize: 12 }}>(inert: slots are detected per bot)</span>
          </label>

          <p style={{ color: "var(--muted, #999)", fontSize: 13, marginTop: 28, maxWidth: 640 }}>
            Season rollover is automatic: the fleet follows Realm&apos;s season clock and marks every
            account non-seasonal the minute the season ends (see the fleet&apos;s /backpacks status).
          </p>
        </section>
      )}

      {/* Mounted only while selected, so switching away stops its poll loop. */}
      {tab === "inventories" && <InventoriesTab password={password} />}
      {tab === "accounts" && <AccountsTab password={password} />}
      {tab === "backpacks" && <BackpacksTab password={password} />}

      {tab === "deposits" && <DepositsTab password={password} />}

      {tab === "itempoints" && <ItemPointsTab password={password} />}

      {tab === "cosmetics" && <CosmeticsTab password={password} />}
      {tab === "leaderboard" && <LeaderboardTab password={password} />}
      {tab === "servercontrols" && <ServerControlTab password={password} />}
      {tab === "proxies" && <ProxiesTab password={password} />}
      {tab === "tutorials" && <TutorialsTab password={password} />}
      {tab === "namedaccount" && <NamedAccountTab password={password} />}
      {tab === "blog" && <BlogTab password={password} />}
      {tab === "skins" && <SkinsTab password={password} />}
      {tab === "features" && <FeaturesTab password={password} />}
      {tab === "wishlists" && <WishlistsTab password={password} />}
      {tab === "vaultcaps" && <VaultCapsTab password={password} />}
      {tab === "traffic" && <TrafficTab password={password} />}

      {tab === "ratelimits" && (
        <section>
          <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12 }}>
            Cap how many items a player can withdraw per rolling 24h window.
            Limits lift automatically when they expire; deposits are never limited.
          </p>

          <form
            onSubmit={submitNewLimit}
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}
          >
            <input
              placeholder="IGN"
              value={newIgn}
              onChange={(e) => setNewIgn(e.target.value)}
              style={{ ...inputStyle, width: 160 }}
            />
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="number"
                min={1}
                max={1000}
                value={newPerDay}
                onChange={(e) => setNewPerDay(e.target.value)}
                style={{ ...inputStyle, width: 70 }}
              />
              items/day
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              for
              <input
                type="number"
                min={1}
                max={365}
                value={newDays}
                onChange={(e) => setNewDays(e.target.value)}
                style={{ ...inputStyle, width: 70 }}
              />
              days
            </label>
            <button type="submit" disabled={savingLimit || !newIgn.trim()} style={buttonStyle}>
              {savingLimit ? "…" : "Limit player"}
            </button>
          </form>

          {limits === null ? (
            <p>Loading…</p>
          ) : limits.length === 0 ? (
            <p style={{ color: "var(--muted, #999)" }}>No rate-limited players.</p>
          ) : (
            <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 720 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted, #999)", fontSize: 12 }}>
                  <th style={{ padding: "6px 10px 6px 0" }}>IGN</th>
                  <th style={{ padding: "6px 10px 6px 0" }}>Limit</th>
                  <th style={{ padding: "6px 10px 6px 0" }}>Used (24h)</th>
                  <th style={{ padding: "6px 10px 6px 0" }}>Expires</th>
                  <th style={{ padding: "6px 0" }}></th>
                </tr>
              </thead>
              <tbody>
                {limits.map((l) => (
                  <tr key={l.ignLower} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 10px 8px 0", fontWeight: 600 }}>
                      <PlayerName ign={l.ign} readable />
                    </td>
                    {editing === l.ignLower ? (
                      <>
                        <td style={{ padding: "8px 10px 8px 0" }}>
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            value={editPerDay}
                            onChange={(e) => setEditPerDay(e.target.value)}
                            style={{ ...inputStyle, width: 70, padding: "4px 8px" }}
                          />{" "}
                          /day
                        </td>
                        <td style={{ padding: "8px 10px 8px 0" }}>
                          {l.usedToday}
                        </td>
                        <td style={{ padding: "8px 10px 8px 0" }}>
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={editDays}
                            onChange={(e) => setEditDays(e.target.value)}
                            style={{ ...inputStyle, width: 70, padding: "4px 8px" }}
                          />{" "}
                          days from now
                        </td>
                        <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                          <button
                            className="nav-link"
                            disabled={savingLimit}
                            onClick={() => submitEdit(l)}
                          >
                            save
                          </button>{" "}
                          <button className="nav-link" onClick={() => setEditing(null)}>
                            cancel
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td style={{ padding: "8px 10px 8px 0" }}>{l.itemsPerDay}/day</td>
                        <td
                          style={{
                            padding: "8px 10px 8px 0",
                            color: l.usedToday >= l.itemsPerDay ? "var(--bad)" : undefined,
                          }}
                        >
                          {l.usedToday}
                        </td>
                        <td style={{ padding: "8px 10px 8px 0" }} title={new Date(l.expiresAt).toLocaleString()}>
                          {daysLeft(l.expiresAt)}
                        </td>
                        <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                          <button className="nav-link" onClick={() => startEdit(l)}>
                            edit
                          </button>{" "}
                          <button
                            className="nav-link"
                            disabled={savingLimit}
                            onClick={() => deleteLimit(l.ign)}
                          >
                            remove
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
        </div>
      </div>
    </main>
  );
}
