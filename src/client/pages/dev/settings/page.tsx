import { useEffect, useState } from "react";
import InventoriesTab from "./InventoriesTab";
import DepositsTab from "./DepositsTab";
import AccountsTab from "./AccountsTab";
import BackpacksTab from "./BackpacksTab";
import ItemPointsTab from "./ItemPointsTab";
import ServerControlTab from "./ServerControlTab";
import TutorialsTab from "./TutorialsTab";
import FeaturesTab from "./FeaturesTab";
import WishlistsTab from "./WishlistsTab";
import VaultCapsTab from "./VaultCapsTab";
import NodeTab from "./NodeTab";
import SiteHeader from "@/components/SiteHeader";
import ProxiesTab from "./ProxiesTab";
import OffersTab from "./OffersTab";

// The control panel: everything about running the node. Each tool lives in
// exactly one category; the categories run across the top and the
// category's tools down the left. In local mode there is no password
// (src/node/config.ts); the form only appears when the server asks for one.

const STORAGE_KEY = "control_password";

type DevTab =
  | "node"
  | "proxies"
  | "inventories"
  | "accounts"
  | "backpacks"
  | "deposits"
  | "offers"
  | "itempoints"
  | "servercontrols"
  | "tutorials"
  | "features"
  | "wishlists"
  | "vaultcaps";

type DevCategory = "fleet" | "economy" | "players";
const CATEGORIES: { id: DevCategory; label: string; tabs: { id: DevTab; label: string }[] }[] = [
  {
    id: "fleet",
    label: "Fleet",
    tabs: [
      { id: "node", label: "Node" },
      { id: "proxies", label: "Proxies" },
      { id: "inventories", label: "Inventories" },
      { id: "accounts", label: "Accounts" },
      { id: "backpacks", label: "Backpacks" },
      { id: "tutorials", label: "Tutorials" },
      { id: "servercontrols", label: "Server controls" },
    ],
  },
  {
    id: "economy",
    label: "Economy",
    tabs: [
      { id: "offers", label: "Offers" },
      { id: "deposits", label: "Deposits" },
      { id: "itempoints", label: "Item points" },
    ],
  },
  {
    id: "players",
    label: "Players",
    tabs: [
      { id: "features", label: "Feature access" },
      { id: "wishlists", label: "Wishlists" },
      { id: "vaultcaps", label: "Vault caps" },
    ],
  },
];
const categoryOf = (tab: DevTab): DevCategory => CATEGORIES.find((c) => c.tabs.some((t) => t.id === tab))?.id ?? "fleet";
const TAB_KEY = "control_tab";
function rememberedTab(): DevTab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v && CATEGORIES.some((c) => c.tabs.some((t) => t.id === v))) return v as DevTab;
  } catch {
    // Storage blocked: start on the first tool.
  }
  return "node";
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

  return (
    <>
      <SiteHeader />
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
        {password && (
          <button
            className="nav-link"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              sessionStorage.removeItem(STORAGE_KEY);
              setAuthed(false);
              setPassword("");
            }}
          >
            lock
          </button>
        )}
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
          {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

          {/* Mounted only while selected, so switching away stops its poll loop. */}
          {tab === "node" && <NodeTab password={password} />}
          {tab === "proxies" && <ProxiesTab password={password} />}
          {tab === "inventories" && <InventoriesTab password={password} />}
          {tab === "accounts" && <AccountsTab password={password} />}
          {tab === "backpacks" && <BackpacksTab password={password} />}
          {tab === "offers" && <OffersTab password={password} />}
          {tab === "deposits" && <DepositsTab password={password} />}
          {tab === "itempoints" && <ItemPointsTab password={password} />}
          {tab === "servercontrols" && <ServerControlTab password={password} />}
          {tab === "tutorials" && <TutorialsTab password={password} />}
          {tab === "features" && <FeaturesTab password={password} />}
          {tab === "wishlists" && <WishlistsTab password={password} />}
          {tab === "vaultcaps" && <VaultCapsTab password={password} />}
        </div>
      </div>
    </>
  );
}
