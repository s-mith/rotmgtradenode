import { useState } from "react";
import guide from "../../../docs/getting-started.md?raw";
import faq from "../../../docs/faq.md?raw";
import { getDiagnostics } from "./api";
import DesktopSettings from "./DesktopSettings";
import Markdown from "./Markdown";
import { DISCORD_URL } from "@/components/discord";

// Help, in the app: a one-press diagnostics copy for the Discord helpers,
// the desktop app's folders and settings, and the same guide and FAQ as
// docs/getting-started.md and docs/faq.md.

export default function HelpPanel() {
  const desktop = typeof window !== "undefined" ? window.desktop : undefined;
  const [diag, setDiag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function copyDiagnostics() {
    setBusy(true);
    setMsg(null);
    const r = await getDiagnostics();
    setBusy(false);
    if (!r.ok) {
      setMsg({ tone: "bad", text: r.error });
      return;
    }
    setDiag(r.data.text);
    try {
      await navigator.clipboard.writeText(r.data.text);
      setMsg({ tone: "ok", text: "Copied. Paste it in the help channel on our Discord (Ctrl+V)." });
    } catch {
      setMsg({ tone: "bad", text: "Could not copy by itself: open “Show what is copied” below, select all of it (Ctrl+A) and copy it (Ctrl+C)." });
    }
  }

  return (
    <div className="help setup">
      <section className="ui-card" aria-label="Get help">
        <h2>Get help</h2>
        <p className="ui-note">
          Press the button, then paste in the help channel on <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">our Discord</a>.
          It copies what the helpers need to see what is wrong. Passwords, emails and proxy logins are removed first.
        </p>
        <div className="ui-row">
          <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void copyDiagnostics()}>
            {busy ? "Collecting…" : "Copy diagnostics"}
          </button>
          {desktop && (
            <>
              <button type="button" className="ui-btn" onClick={() => void desktop.openLogFolder()}>Open log folder</button>
              <button type="button" className="ui-btn" onClick={() => void desktop.openDataFolder()}>Open data folder</button>
            </>
          )}
        </div>
        {msg && <p className={`ui-msg ${msg.tone}`} role="status">{msg.text}</p>}
        {diag && (
          <details className="ui-more">
            <summary>Show what is copied</summary>
            <textarea className="ui-textarea" readOnly value={diag} aria-label="Diagnostics" style={{ minHeight: 220 }} onFocus={(e) => e.currentTarget.select()} />
          </details>
        )}
      </section>

      <div style={{ marginTop: 14 }}>
        <DesktopSettings />
      </div>

      <section className="ui-card" style={{ marginTop: 14 }} aria-label="Getting started">
        <Markdown source={guide} id="guide" />
      </section>
      <section className="ui-card" style={{ marginTop: 14 }} aria-label="Questions and answers">
        <Markdown source={faq} id="faq" />
      </section>
    </div>
  );
}
