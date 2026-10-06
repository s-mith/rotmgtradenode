import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DEV_PASSWORD_KEY } from "@/components/devHeaders";
import { getSetup } from "@/client/shared/api";
import InventoriesTab from "./InventoriesTab";
import DepositsTab from "./DepositsTab";
import AccountsTab from "./AccountsTab";
import StorageTab from "./StorageTab";
import AcceptedItemsTab from "./AcceptedItemsTab";
import ServerControlTab from "./ServerControlTab";
import NodeTab from "./NodeTab";
import SiteHeader from "@/components/SiteHeader";
import ProxiesTab from "./ProxiesTab";
import OffersTab from "./OffersTab";
import CommunismTab from "./CommunismTab";
import OverviewTab, { StatusStrip, useOverview } from "./OverviewTab";

// The control panel: everything about running the node. The Overview is
// what is happening now; Setup is what you touch once (the build gate and
// hub link, the roster, proxies, what the bots take in); Fleet is what you
// watch (what the accounts hold, their chores); Trading is the hub-facing
// side. The tab lives in the URL hash so it can be bookmarked and shared,
// and a status strip under the categories keeps the vital signs in view on
// every tab. In local mode there is no password (src/node/config.ts); the
// form only appears when the server asks for one.

const STORAGE_KEY = DEV_PASSWORD_KEY;

type DevTab =
  | "overview"
  | "node"
  | "proxies"
  | "servercontrols"
  | "items"
  | "accounts"
  | "inventories"
  | "storage"
  | "offers"
  | "communism"
  | "deposits";

/** The tabs in the top row, in order. Every tab is a top-level tab; there are no sections. */
const TABS: { id: DevTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  // Node & hub (the build gate, the hub link, telemetry) is part of Overview; the tab stays at #node.
  { id: "accounts", label: "Accounts" },
  { id: "proxies", label: "Proxies" },
  // Accepted items: hidden for now; the tab stays at #items and the setting still applies.
  // Offers: meetings show on the main page's Trading desk; the tab stays at #offers.
  // Communism: the "Across the hub" panel is on the main page's Communism bookmark; the tab stays at #communism.
];
/**
 * Tabs reachable by hash but not listed: the Servers tab (the load gate runs the servers by itself),
 * Storage (queued moves, the character picker; refreshes run from Accounts), Inventories,
 * Requests (open deposits and withdraws), and Accepted items. Their code stays for a deep link and for when they are wanted again.
 */
const HIDDEN_TABS: DevTab[] = ["servercontrols", "storage", "inventories", "deposits", "node", "communism", "offers", "items"];
const ALL_TABS = new Set<string>([...TABS.map((t) => t.id), ...HIDDEN_TABS]);
const TAB_KEY = "control_tab";

/** The tab from the URL hash (a bookmark or a shared link), else the last one used, else the overview. */
function initialTab(): DevTab {
  const fromHash = location.hash.replace(/^#/, "");
  if (ALL_TABS.has(fromHash)) return fromHash as DevTab;
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v && ALL_TABS.has(v)) return v as DevTab;
  } catch {
    // Storage blocked: start on the overview.
  }
  return "overview";
}

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

export default function DevSettingsPage() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [tab, setTabState] = useState<DevTab>(initialTab);
  const setTab = (t: string) => {
    if (!ALL_TABS.has(t)) return;
    setTabState(t as DevTab);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      // Storage blocked: the pick just doesn't survive a reload.
    }
    if (location.hash !== `#${t}`) history.replaceState(null, "", `#${t}`);
  };
  // Back/forward and a pasted link with a hash land on that tab.
  useEffect(() => {
    const onHash = () => {
      const t = location.hash.replace(/^#/, "");
      if (ALL_TABS.has(t)) setTabState(t as DevTab);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Restore a saved password on first mount; with none, try without one:
  // in local mode the console needs no password (src/node/config.ts).
  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) setPassword(saved);
    tryLoad(saved ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tryLoad(pw: string) {
    setLoading(true);
    setError("");
    try {
      // Auth against the settings endpoint: it only needs DEV_PASSWORD.
      const r = await fetch("/api/dev/settings", {
        headers: { "x-dev-password": pw },
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        setAuthed(false);
        return;
      }
      setAuthed(true);
      if (pw) sessionStorage.setItem(STORAGE_KEY, pw);
    } catch (e) {
      setError(String(e));
      setAuthed(false);
    } finally {
      setLoading(false);
    }
  }

  if (!authed) {
    return (
      <>
        <SiteHeader />
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Control panel</h2>
        {!loading && (
          <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12, maxWidth: 560 }}>
            This node is set up with a password (DEV_PASSWORD). Enter it to open the control panel.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            tryLoad(password);
          }}
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={{ ...inputStyle, width: 280 }}
          />
          <button type="submit" disabled={loading} style={buttonStyle}>
            {loading ? "…" : "Unlock"}
          </button>
        </form>
        {error && !loading && <p style={{ color: "var(--bad)", marginTop: 12 }}>{error}</p>}
      </>
    );
  }

  return <Panel password={password} tab={tab} setTab={setTab} error={error} lock={password ? () => { sessionStorage.removeItem(STORAGE_KEY); setAuthed(false); setPassword(""); } : null} />;
}

/** Whether the first-run setup is still open (null: not known, or a node too old to say). */
function useSetupOpen(): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void getSetup().then((r) => {
      if (live) setOpen(r.ok ? !r.data.complete : null);
    });
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return open;
}

function Panel({ password, tab, setTab, error, lock }: { password: string; tab: DevTab; setTab: (t: string) => void; error: string; lock: (() => void) | null }) {
  const { data: overview } = useOverview(password);
  const attention = overview?.attention.length ?? 0;
  const setupOpen = useSetupOpen();
  return (
    <>
      <SiteHeader />
      {/* On the Overview the status card already says so, with its own button. */}
      {setupOpen && tab !== "overview" && (
        <div className="setup-banner" role="status">
          <span><b>Setup is not finished.</b> A few steps are left before your bots can trade.</span>
          <Link className="ui-btn primary small" to="/setup">Finish setting up</Link>
        </div>
      )}
      <div className="panel-categories" role="tablist" aria-label="Control panel tabs">
        {TABS.map((t) => (
          <button key={t.id} className={"nav-link" + (tab === t.id ? " active" : "")} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "overview" && attention > 0 && <span className="tab-badge bad">{attention}</span>}
            {t.id === "accounts" && overview && overview.accounts.attention.length + overview.accounts.suspended > 0 && <span className="tab-badge">{overview.accounts.attention.length + overview.accounts.suspended}</span>}
            {t.id === "offers" && overview && overview.meetings.open > 0 && <span className="tab-badge">{overview.meetings.open}</span>}
          </button>
        ))}
        {lock && (
          <button className="nav-link" style={{ marginLeft: "auto" }} onClick={lock}>
            lock
          </button>
        )}
      </div>
      {tab !== "overview" && <StatusStrip o={overview} go={setTab} />}

      <div className="dev-body single">
        <div className="dev-main">
          {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

          {/* Mounted only while selected, so switching away stops its poll loop. */}
          {tab === "overview" && <OverviewTab password={password} go={setTab} />}
          {tab === "node" && <NodeTab password={password} />}
          {tab === "proxies" && <ProxiesTab password={password} />}
          {tab === "inventories" && <InventoriesTab password={password} />}
          {tab === "accounts" && <AccountsTab password={password} />}
          {tab === "storage" && <StorageTab password={password} />}
          {tab === "items" && <AcceptedItemsTab password={password} />}
          {tab === "offers" && <OffersTab password={password} />}
          {tab === "communism" && <CommunismTab />}
          {tab === "deposits" && <DepositsTab password={password} />}
          {tab === "servercontrols" && <ServerControlTab password={password} />}
        </div>
      </div>
    </>
  );
}
