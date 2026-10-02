import { useEffect, useRef, useState, type ReactNode } from "react";
import { getProxies, parseProxies, saveProxies, testProxies, type ParsedLine, type ProxyTest } from "./api";

// Paste proxies, see at once which lines the node understands, save, and test
// them for real (each one reaches Realm's website and a game server through
// the proxy). Shared by the setup wizard and the control panel's Proxies tab.

/** Free proxies for a new owner: Webshare gives 10 when you sign up, with no card needed. */
export const FREE_PROXIES_URL = "https://www.webshare.io/";

function FreeProxiesLink({ children }: { children: ReactNode }) {
  return (
    <a href={FREE_PROXIES_URL} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function ProxyExplainer() {
  return (
    <details className="ui-more">
      <summary>What is a proxy, and where do I get one?</summary>
      <div className="ui-note">
        <p>
          A proxy is an internet address you rent. Your bots log in to Realm through it, so the game does not see all of them
          coming from your home connection — the one your main account uses. One proxy carries one bot at a time.
        </p>
        <p>
          To start for free, sign up at <FreeProxiesLink>Webshare</FreeProxiesLink>: it gives you 10 proxies at no cost, with no card needed. For more
          bots, search the web for <b>&ldquo;SOCKS5 proxies&rdquo;</b> and buy from a seller you trust: dedicated (not shared) ones work best. Either way
          you get a list of lines such as <span className="ui-mono">1.2.3.4:1080:username:password</span>. Copy the whole list and paste it below.
          Most formats work; the node tells you line by line what it understood.
        </p>
      </div>
    </details>
  );
}

/** For an owner with no proxies yet: where to get some for free, in plain sight. */
function FreeProxiesOffer() {
  return (
    <div className="ui-msg" role="note" style={{ marginTop: 0 }}>
      <p style={{ margin: "0 0 10px" }}>
        <b>No proxies yet?</b> Webshare gives you 10 free proxies when you sign up, with no card needed. Sign up, copy your proxy list from
        Webshare, and paste it below.
      </p>
      <a className="ui-btn small primary" href={FREE_PROXIES_URL} target="_blank" rel="noopener noreferrer">
        Get 10 free proxies at Webshare <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}

export default function ProxyEditor({ onSaved }: { onSaved?: (count: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [lines, setLines] = useState<ParsedLine[] | null>(null);
  const [parseNote, setParseNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<ProxyTest[] | null>(null);
  const seq = useRef(0);

  // The saved list seeds the box once; what the person types is never overwritten.
  useEffect(() => {
    void getProxies().then((r) => {
      if (!r.ok) return;
      setSaved(r.data.text ?? "");
      setText((t) => (t === null ? r.data.text ?? "" : t));
    });
  }, []);

  // Line-by-line feedback as they paste, a moment after they stop typing.
  useEffect(() => {
    if (text === null) return;
    const mine = ++seq.current;
    if (!text.trim()) {
      setLines([]);
      return;
    }
    const t = setTimeout(() => {
      void parseProxies(text).then((r) => {
        if (mine !== seq.current) return;
        if (r.ok) {
          setLines(r.data.lines ?? []);
          setParseNote("");
        } else {
          setLines(null);
          setParseNote(r.status === 404 ? "" : r.error);
        }
      });
    }, 400);
    return () => clearTimeout(t);
  }, [text]);

  async function save() {
    if (text === null) return;
    setBusy(true);
    setMsg(null);
    setResults(null);
    const r = await saveProxies(text);
    setBusy(false);
    if (!r.ok) {
      setMsg({ tone: "bad", text: r.error });
      return;
    }
    setSaved(r.data.text ?? text);
    setText(r.data.text ?? text);
    const count = r.data.saved?.count ?? r.data.proxies?.length ?? 0;
    setMsg(r.data.saved?.error ? { tone: "bad", text: `Saved ${count} prox${count === 1 ? "y" : "ies"}, but: ${r.data.saved.error}` } : { tone: "ok", text: count ? `Saved ${count} prox${count === 1 ? "y" : "ies"}. Now press “Test my proxies”.` : "Saved: no proxies." });
    onSaved?.(count);
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    setResults(null);
    const r = await testProxies();
    setTesting(false);
    if (!r.ok) {
      setMsg({ tone: "bad", text: r.error });
      return;
    }
    setResults(r.data.results ?? []);
    // What works is part of whether the bots can connect: the setup reads it again.
    onSaved?.((r.data.results ?? []).filter((x) => x.ok).length);
  }

  const good = lines?.filter((l) => l.ok).length ?? 0;
  const bad = lines?.filter((l) => !l.ok) ?? [];
  // Lines read fine but worth a word (an http:// line tried as SOCKS5, a duplicate kept once).
  const notes = (lines ?? []).filter((l): l is typeof l & { note: string } => l.ok && typeof (l as { note?: unknown }).note === "string");
  const unsaved = text !== null && saved !== null && text.trim() !== saved.trim();
  const working = results?.filter((x) => x.ok).length ?? 0;
  return (
    <div>
      {saved !== null && !saved.trim() && <FreeProxiesOffer />}
      <ProxyExplainer />
      <div className="ui-field" style={{ marginTop: 12 }}>
        <label htmlFor="proxy-list">Your proxies, one per line</label>
        <textarea
          id="proxy-list"
          className="ui-textarea"
          value={text ?? ""}
          onChange={(e) => setText(e.target.value)}
          placeholder={"1.2.3.4:1080:username:password\nusername:password@5.6.7.8:1080\nsocks5://9.10.11.12:1080"}
          spellCheck={false}
          aria-describedby="proxy-feedback"
        />
        <div id="proxy-feedback" className="hint" aria-live="polite">
          {lines && lines.length > 0 && (
            <span className={bad.length ? "ui-warn" : "ui-ok"}>
              {good} line{good === 1 ? "" : "s"} understood{bad.length ? `, ${bad.length} not` : ""}.
            </span>
          )}
          {parseNote && <span className="ui-bad">{parseNote}</span>}
        </div>
        {notes.length > 0 && (
          <ul className="ui-list" aria-label="Lines with a note">
            {notes.slice(0, 12).map((l) => (
              <li key={l.line}>
                <span className="mark ui-warn" aria-hidden="true">!</span>
                <span>
                  Line {l.line}: {l.note}
                </span>
              </li>
            ))}
          </ul>
        )}
        {bad.length > 0 && (
          <ul className="ui-list" aria-label="Lines the node did not understand">
            {bad.slice(0, 12).map((l) => (
              <li key={l.line}>
                <span className="mark ui-bad" aria-hidden="true">✗</span>
                <span>
                  Line {l.line}: {(l as { error: string }).error} <span className="ui-mono ui-note">{(l as { raw: string }).raw}</span>
                </span>
              </li>
            ))}
            {bad.length > 12 && <li className="ui-note">…and {bad.length - 12} more.</li>}
          </ul>
        )}
      </div>
      <div className="ui-row">
        <button type="button" className="ui-btn primary" disabled={busy || text === null || !unsaved} onClick={() => void save()}>
          {busy ? "Saving…" : "Save proxies"}
        </button>
        <button type="button" className="ui-btn" disabled={testing || busy || unsaved || !saved?.trim()} onClick={() => void test()} title={unsaved ? "Save the list first" : undefined}>
          {testing ? "Testing… (up to a minute)" : "Test my proxies"}
        </button>
        {unsaved && <span className="ui-note">Not saved yet.</span>}
      </div>
      {msg && <p className={`ui-msg ${msg.tone}`} role="status">{msg.text}</p>}
      {results && (
        <div className="ui-msg" role="status" style={{ marginTop: 12 }}>
          <b className={working === results.length && working > 0 ? "ui-ok" : working ? "ui-warn" : "ui-bad"}>
            {results.length === 0 ? "No proxies to test." : `${working} of ${results.length} prox${results.length === 1 ? "y works" : "ies work"}.`}
          </b>
          <ul className="ui-list">
            {results.map((x) => (
              <li key={x.host}>
                <span className={`mark ${x.ok ? "ui-ok" : "ui-bad"}`} aria-hidden="true">{x.ok ? "✓" : "✗"}</span>
                <span>
                  <span className="ui-mono">{x.host}</span> — {x.ok ? (x.ms !== undefined ? `works (${x.ms} ms)` : "works") : x.error ?? "does not work"}
                </span>
              </li>
            ))}
          </ul>
          {results.length > 0 && working < results.length && <p className="ui-note" style={{ margin: "6px 0 0" }}>Proxies that do not work are skipped. If none work, check the list with your proxy seller.</p>}
        </div>
      )}
    </div>
  );
}
