import { useEffect, useState } from "react";
import InventoriesTab from "./InventoriesTab";
import DepositsTab from "./DepositsTab";
import CosmeticsTab from "./CosmeticsTab";
import AccountsTab from "./AccountsTab";
import BackpacksTab from "./BackpacksTab";
import ItemPointsTab from "./ItemPointsTab";
import ServerControlTab from "./ServerControlTab";
import TutorialsTab from "./TutorialsTab";
import SkinsTab from "./SkinsTab";
import FeaturesTab from "./FeaturesTab";
import WishlistsTab from "./WishlistsTab";
import VaultCapsTab from "./VaultCapsTab";

// Dev — operator console. Each tool lives in exactly one category; the
// categories run across the top and the category's tools down the left.

const STORAGE_KEY = "dev_password";

type DevTab =
  | "inventories"
  | "accounts"
  | "backpacks"
  | "deposits"
  | "itempoints"
  | "cosmetics"
  | "servercontrols"
  | "tutorials"
  | "skins"
  | "features"
  | "wishlists"
  | "vaultcaps";

type DevCategory = "fleet" | "economy" | "players" | "content";
const CATEGORIES: { id: DevCategory; label: string; tabs: { id: DevTab; label: string }[] }[] = [
  {
    id: "fleet",
    label: "Fleet",
    tabs: [
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
      { id: "deposits", label: "Deposits" },
      { id: "itempoints", label: "Item points" },
    ],
  },
  {
    id: "players",
    label: "Players",
    tabs: [
      { id: "cosmetics", label: "Cosmetics" },
      { id: "features", label: "Feature access" },
      { id: "wishlists", label: "Wishlists" },
      { id: "vaultcaps", label: "Vault caps" },
    ],
  },
  {
    id: "content",
    label: "Content",
    tabs: [{ id: "skins", label: "Skins" }],
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
  return "inventories";
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
      sessionStorage.setItem(STORAGE_KEY, pw);
    } catch (e) {
      setError(String(e));
      setAuthed(false);
    } finally {
      setLoading(false);
    }
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
          {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

          {/* Mounted only while selected, so switching away stops its poll loop. */}
          {tab === "inventories" && <InventoriesTab password={password} />}
          {tab === "accounts" && <AccountsTab password={password} />}
          {tab === "backpacks" && <BackpacksTab password={password} />}
          {tab === "deposits" && <DepositsTab password={password} />}
          {tab === "itempoints" && <ItemPointsTab password={password} />}
          {tab === "cosmetics" && <CosmeticsTab password={password} />}
          {tab === "servercontrols" && <ServerControlTab password={password} />}
          {tab === "tutorials" && <TutorialsTab password={password} />}
          {tab === "skins" && <SkinsTab password={password} />}
          {tab === "features" && <FeaturesTab password={password} />}
          {tab === "wishlists" && <WishlistsTab password={password} />}
          {tab === "vaultcaps" && <VaultCapsTab password={password} />}
        </div>
      </div>
    </main>
  );
}
