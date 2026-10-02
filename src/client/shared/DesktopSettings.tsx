import { useEffect, useState } from "react";

// The desktop app's own settings (window.desktop, electron/preload.cjs):
// keep Windows awake while the node runs, and start with Windows in the tray.
// Nothing shows in a plain browser, where neither applies.

export default function DesktopSettings() {
  const desktop = typeof window !== "undefined" ? window.desktop : undefined;
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!desktop) return;
    desktop.getPrefs().then(setPrefs, (e) => setError(String(e?.message ?? e)));
  }, [desktop]);

  if (!desktop) return null;
  async function change(p: Partial<DesktopPrefs>) {
    if (!desktop) return;
    setError("");
    try {
      setPrefs(await desktop.setPrefs(p));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }
  return (
    <section className="ui-card" aria-label="App settings">
      <h2>App settings</h2>
      {!prefs ? (
        <p className="ui-note">Loading…</p>
      ) : (
        <>
          <label className="ui-toggle">
            <input type="checkbox" checked={prefs.keepAwake} onChange={(e) => void change({ keepAwake: e.target.checked })} />
            <span>
              <b>Keep this PC awake while the node runs</b>
              <span className="ui-note">If Windows goes to sleep, your bots go offline and nobody can trade with them. The screen can still turn off.</span>
            </span>
          </label>
          <label className="ui-toggle">
            <input type="checkbox" checked={prefs.startWithWindows} onChange={(e) => void change({ startWithWindows: e.target.checked })} />
            <span>
              <b>Start with Windows</b>
              <span className="ui-note">The node starts by itself when you sign in to Windows, quietly in the tray (the small icons near the clock).</span>
            </span>
          </label>
        </>
      )}
      {error && <p className="ui-msg bad" role="alert">{error}</p>}
      <p className="ui-note" style={{ marginTop: 8 }}>App version {desktop.version}</p>
    </section>
  );
}
