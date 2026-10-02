import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import SiteHeader from "@/components/SiteHeader";
import AddAccountForm from "@/client/shared/AddAccountForm";
import DesktopSettings from "@/client/shared/DesktopSettings";
import OwnInternet from "@/client/shared/OwnInternet";
import ProxyEditor from "@/client/shared/ProxyEditor";
import { getProxies, getSetup, linkHub, listAccounts, nodeInfo, postSetup, saveProxies, type AccountRow, type SetupState, type TestLogin } from "@/client/shared/api";

// First run: from a fresh install to a bot standing in the Nexus, for someone
// who has never run a server. One question per screen, plain words, and the
// state lives on the node (GET /api/dev/setup), so a reload or a closed
// window picks up where it stopped. The connection comes before the
// accounts: adding an account asks Realm about it, which needs a way out.

type Step = "welcome" | "connection" | "accounts" | "hub" | "test" | "done";
const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "connection", label: "Connection" },
  { id: "accounts", label: "Accounts" },
  { id: "hub", label: "rotmg trade" },
  { id: "test", label: "Test" },
  { id: "done", label: "Done" },
];
const isStep = (s: string): s is Step => STEPS.some((x) => x.id === s);

/** Where to pick up: the first step not done yet. */
function firstOpen(s: SetupState | null): Step {
  if (!s) return "welcome";
  if (s.complete) return "done";
  const st = s.steps;
  if (!st.connection.done && !st.accounts.done) return "welcome";
  if (!st.connection.done) return "connection";
  if (!st.accounts.done) return "accounts";
  if (!st.hub.done) return "hub";
  if (!st.test.done) return "test";
  return "done";
}

export default function SetupPage() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [apiMissing, setApiMissing] = useState(false);
  const [step, setStepState] = useState<Step | null>(() => {
    const h = location.hash.replace(/^#/, "");
    return isStep(h) ? h : null;
  });
  const heading = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async () => {
    const r = await getSetup();
    if (r.ok) {
      setSetup(r.data);
      setApiMissing(false);
      return r.data;
    }
    if (r.status === 404) setApiMissing(true);
    return null;
  }, []);

  useEffect(() => {
    void refresh().then((s) => setStepState((cur) => cur ?? firstOpen(s)));
  }, [refresh]);

  const setStep = (s: Step) => {
    setStepState(s);
    history.replaceState(null, "", `#${s}`);
  };
  // A new screen: move the focus to its title, so a screen reader starts there.
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const index = step ? STEPS.findIndex((s) => s.id === step) : 0;
  const go = (delta: number) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, index + delta))].id);
  const doneOf = (id: Step): boolean => {
    const st = setup?.steps;
    if (!st) return false;
    return id === "welcome" ? st.connection.done || st.accounts.done : id === "connection" ? st.connection.done : id === "accounts" ? st.accounts.done : id === "hub" ? st.hub.done : id === "test" ? st.test.done : !!setup?.complete;
  };

  async function finish() {
    await postSetup({ action: "complete" });
    navigate("/control");
  }

  return (
    <>
      <SiteHeader />
      <div className="setup">
        <ol className="setup-steps" aria-label="Setup steps">
          {STEPS.map((s) => (
            <li key={s.id} className={doneOf(s.id) && s.id !== step ? "done" : ""} aria-current={s.id === step ? "step" : undefined}>
              {s.label}
            </li>
          ))}
        </ol>
        {apiMissing && <p className="ui-msg warn">This version of the node cannot keep track of the setup. You can still follow the steps.</p>}
        {!step ? (
          <p className="ui-note">Loading…</p>
        ) : (
          <section className="ui-card" aria-labelledby="setup-title">
            {step === "welcome" && <Welcome heading={heading} />}
            {step === "connection" && <Connection heading={heading} setup={setup} onChange={() => void refresh()} />}
            {step === "accounts" && <Accounts heading={heading} onChange={() => void refresh()} />}
            {step === "hub" && <Hub heading={heading} setup={setup} onChange={() => void refresh()} onSkip={async () => { await postSetup({ action: "skip-hub" }); await refresh(); go(1); }} />}
            {step === "test" && <Test heading={heading} setup={setup} refresh={refresh} />}
            {step === "done" && <Done heading={heading} />}

            <div className="setup-nav">
              {index > 0 ? <button type="button" className="ui-btn quiet" onClick={() => go(-1)}>Back</button> : <span />}
              {step === "done" ? (
                <button type="button" className="ui-btn primary" onClick={() => void finish()}>Open the control panel</button>
              ) : step === "welcome" ? (
                <button type="button" className="ui-btn primary" onClick={() => go(1)}>Let&apos;s start</button>
              ) : (
                <NextButton step={step} setup={setup} apiMissing={apiMissing} onNext={() => go(1)} />
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

/** Next is open once the step is done; the test can also be left for later. */
function NextButton({ step, setup, apiMissing, onNext }: { step: Step; setup: SetupState | null; apiMissing: boolean; onNext: () => void }) {
  const st = setup?.steps;
  const ready = apiMissing || (step === "connection" ? !!st?.connection.done : step === "accounts" ? !!st?.accounts.done : step === "hub" ? !!st?.hub.done : step === "test" ? !!st?.test.done : true);
  const hint = step === "connection" ? "Save at least one proxy, or allow your own internet." : step === "accounts" ? "Add at least one account." : step === "hub" ? "Link your node, or press Skip for now." : "";
  if (step === "test" && !ready) {
    return (
      <span className="ui-row">
        <button type="button" className="ui-link" onClick={onNext}>Skip the test</button>
        <button type="button" className="ui-btn primary" disabled>Next</button>
      </span>
    );
  }
  return (
    <span className="ui-row">
      {!ready && hint && <span className="ui-note">{hint}</span>}
      <button type="button" className="ui-btn primary" disabled={!ready} onClick={onNext}>Next</button>
    </span>
  );
}

type HeadingRef = React.RefObject<HTMLHeadingElement | null>;

function Welcome({ heading }: { heading: HeadingRef }) {
  return (
    <>
      <h1 id="setup-title" ref={heading} tabIndex={-1}>Welcome to rotmg trade node</h1>
      <p>
        This app runs a trading pool for Realm of the Mad God on your own computer. Your own alt accounts hold the items, and bots log in to
        trade with players in the Nexus. The setup takes about five minutes.
      </p>
      <p><b>You need:</b></p>
      <ul className="setup-what">
        <li><b>Realm alt accounts</b> with an email and password, the tutorial finished. Never use your main account.</li>
        <li><b>Proxies</b> (recommended), or your own internet for one bot at a time. The next step explains both.</li>
      </ul>
      <p className="ui-note">You can stop at any time; the setup continues where you left off.</p>
    </>
  );
}

function Connection({ heading, setup, onChange }: { heading: HeadingRef; setup: SetupState | null; onChange: () => void }) {
  const mode = setup?.steps.connection.mode;
  const [choice, setChoice] = useState<"proxies" | "own" | null>(mode === "own" ? "own" : mode === "proxies" ? "proxies" : null);
  const [ownAllowed, setOwnAllowed] = useState<boolean>(mode === "own");
  useEffect(() => {
    void getProxies().then((r) => {
      if (r.ok) setOwnAllowed(!r.data.required);
    });
  }, []);
  const [clearing, setClearing] = useState(false);
  async function clearProxies() {
    setClearing(true);
    await saveProxies("");
    setClearing(false);
    onChange();
  }
  return (
    <>
      <h2 id="setup-title" ref={heading} tabIndex={-1}>How should your bots connect?</h2>
      <p>Your bots need a way to reach the game. Pick one; you can change it later in the control panel.</p>
      <div className="ui-choices" role="group" aria-label="Connection">
        <button type="button" className="ui-choice" aria-pressed={choice === "proxies"} onClick={() => setChoice("proxies")}>
          <b>Use proxies (recommended)</b>
          <span>Each bot logs in through its own rented internet address. Your home address stays apart from your bots.</span>
        </button>
        <button type="button" className="ui-choice" aria-pressed={choice === "own"} onClick={() => setChoice("own")}>
          <b>Use my own internet</b>
          <span>Free, one bot at a time, from this computer&apos;s connection. Riskier for your main account.</span>
        </button>
      </div>
      {choice === "proxies" && <ProxyEditor onSaved={onChange} />}
      {choice === "own" && <OwnInternet allowed={ownAllowed} onChange={(a) => { setOwnAllowed(a); onChange(); }} />}
      {choice === "own" && ownAllowed && (setup?.steps.connection.proxies ?? 0) > 0 && (
        <div className="ui-msg bad" role="status">
          <p style={{ margin: 0 }}>
            You still have {setup!.steps.connection.proxies} prox{setup!.steps.connection.proxies === 1 ? "y" : "ies"} listed. Bots use a listed proxy instead of your
            own internet, so remove the list to use your own internet.
          </p>
          <button type="button" style={{ marginTop: 8 }} disabled={clearing} onClick={() => void clearProxies()}>
            {clearing ? "Removing…" : "Remove the proxy list"}
          </button>
        </div>
      )}
      {choice === "proxies" && setup && !setup.steps.connection.done && setup.steps.connection.mode === "proxies" && setup.steps.connection.working === 0 && (
        <p className="ui-msg bad" role="status">
          None of your proxies work yet, so no bot can log in through them. Check the list with your proxy seller and test again, or choose “Use my own internet”.
        </p>
      )}
      {setup?.steps.connection.done && (
        <p className="ui-msg ok" role="status">
          Your bots have a way to connect{setup.steps.connection.mode === "proxies" ? ` (${setup.steps.connection.proxies} prox${setup.steps.connection.proxies === 1 ? "y" : "ies"}${setup.steps.connection.working !== null ? `, ${setup.steps.connection.working} tested working` : ""})` : setup.steps.connection.mode === "own" ? " (your own internet)" : ""}. Press Next.
        </p>
      )}
    </>
  );
}

function accountState(a: AccountRow): { tone: "ok" | "bad" | "warn" | ""; text: string } {
  if (a.suspended) return { tone: "bad", text: "suspended by Realm: it cannot be used" };
  if (a.lastLoginError) return { tone: "warn", text: a.lastLoginError.message };
  if (a.inWorld) return { tone: "ok", text: "in the game now" };
  return { tone: "ok", text: "added" };
}

function Accounts({ heading, onChange }: { heading: HeadingRef; onChange: () => void }) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const load = useCallback(async () => {
    const r = await listAccounts();
    if (r.ok) setAccounts(r.data.accounts ?? []);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <>
      <h2 id="setup-title" ref={heading} tabIndex={-1}>Add your alt accounts</h2>
      <AddAccountForm onAdded={() => { void load(); onChange(); }} />
      <h3 style={{ fontSize: 15, margin: "18px 0 6px" }}>Your accounts</h3>
      {accounts === null ? (
        <p className="ui-note">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="ui-note">None yet. Add at least one.</p>
      ) : (
        <ul className="ui-list" aria-live="polite">
          {accounts.map((a) => {
            const s = accountState(a);
            return (
              <li key={a.guid}>
                <span className={`mark ${s.tone === "ok" ? "ui-ok" : s.tone === "bad" ? "ui-bad" : "ui-warn"}`} aria-hidden="true">{s.tone === "ok" ? "✓" : "!"}</span>
                <span>
                  <b>{a.ign || a.alias}</b> <span className="ui-note">— {s.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const DEFAULT_HUB = "https://rotmg.trade";

function Hub({ heading, setup, onChange, onSkip }: { heading: HeadingRef; setup: SetupState | null; onChange: () => void; onSkip: () => Promise<void> }) {
  const [linked, setLinked] = useState<boolean>(!!setup?.steps.hub.linked);
  const [url, setUrl] = useState(DEFAULT_HUB);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  useEffect(() => {
    void nodeInfo().then((r) => {
      if (r.ok) {
        setLinked(!!r.data.hub?.linked);
        if (r.data.hub?.url) setUrl(r.data.hub.url);
      }
    });
  }, []);
  async function link(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await linkHub(url.trim() || DEFAULT_HUB, code.trim());
    setBusy(false);
    if (!r.ok) {
      setMsg({ tone: "bad", text: /code/i.test(r.error) ? `${r.error} Codes work once and expire: make a new one on the website and paste it again.` : r.error });
      return;
    }
    setLinked(true);
    setCode("");
    setMsg({ tone: "ok", text: "Linked to rotmg trade." });
    onChange();
  }
  return (
    <>
      <h2 id="setup-title" ref={heading} tabIndex={-1}>Connect to rotmg trade (optional)</h2>
      <p>
        rotmg trade is the website where people find your pool, trade with other pools and use communism. Your pool also works without it, and
        you can link it later.
      </p>
      {linked ? (
        <p className="ui-msg ok" role="status">Your node is linked to rotmg trade.</p>
      ) : (
        <>
          <ol className="setup-what">
            <li>Open <a href={`${url.replace(/\/$/, "")}/`} target="_blank" rel="noopener noreferrer">rotmg trade</a> and sign in.</li>
            <li>Open <b>My nodes</b> and press <b>Link my node</b>.</li>
            <li>Copy the code it shows and paste it here.</li>
          </ol>
          <form onSubmit={(e) => void link(e)} aria-label="Link to rotmg trade">
            <div className="ui-row" style={{ alignItems: "flex-end" }}>
              <div className="ui-field" style={{ marginBottom: 0 }}>
                <label htmlFor="link-code">Link code</label>
                <input id="link-code" className="ui-input ui-mono" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="ABCD-1234" />
              </div>
              <button type="submit" className="ui-btn primary" disabled={busy || !code.trim()}>{busy ? "Linking…" : "Link my node"}</button>
              <button type="button" className="ui-btn quiet" onClick={() => void onSkip()}>Skip for now</button>
            </div>
            <details className="ui-more">
              <summary>Advanced</summary>
              <div className="ui-field">
                <label htmlFor="hub-url">Website address</label>
                <input id="hub-url" className="ui-input" value={url} onChange={(e) => setUrl(e.target.value)} />
                <span className="hint">Leave this as it is unless the people running rotmg trade told you otherwise.</span>
              </div>
            </details>
          </form>
        </>
      )}
      {msg && <p className={`ui-msg ${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p>}
      {setup?.steps.hub.skipped && !linked && <p className="ui-note">Skipped for now: you can link later on the control panel&apos;s Overview.</p>}
    </>
  );
}

function Test({ heading, setup, refresh }: { heading: HeadingRef; setup: SetupState | null; refresh: () => Promise<SetupState | null> }) {
  const [last, setLast] = useState<TestLogin | null>(setup?.steps.test.last ?? null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const polling = useRef(false);

  useEffect(() => setLast(setup?.steps.test.last ?? null), [setup]);

  // While a test runs, ask every second and a half how it is going (three minutes at most).
  useEffect(() => {
    if (last?.state !== "running" || polling.current) return;
    polling.current = true;
    const started = Date.now();
    const t = setInterval(() => {
      void refresh().then((s) => {
        const l = s?.steps.test.last ?? null;
        if (l) setLast(l);
        if (!l || l.state !== "running" || Date.now() - started > 180_000) {
          clearInterval(t);
          polling.current = false;
        }
      });
    }, 1500);
    return () => {
      clearInterval(t);
      polling.current = false;
    };
  }, [last?.state, refresh]);

  async function start() {
    setStarting(true);
    setError("");
    const r = await postSetup({ action: "test-login" });
    setStarting(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setLast({ state: "running", account: "", message: "Logging a bot in…", at: Date.now() });
  }

  return (
    <>
      <h2 id="setup-title" ref={heading} tabIndex={-1}>Test a bot</h2>
      <p>Let&apos;s log one bot in to check that everything works. It takes up to a minute, and the bot logs out again afterwards.</p>
      <button type="button" className="ui-btn primary" disabled={starting || last?.state === "running"} onClick={() => void start()}>
        {last?.state === "running" ? "Logging in…" : last ? "Test again" : "Log in a bot now"}
      </button>
      <div aria-live="polite">
        {last?.state === "running" && <p className="ui-msg" role="status">Logging {last.account || "a bot"} in… this can take up to a minute.</p>}
        {last?.state === "ok" && <p className="ui-msg ok" role="status">✓ {last.message}</p>}
        {last?.state === "failed" && (
          <div className="ui-msg bad" role="alert">
            <p style={{ margin: "0 0 6px" }}>✗ {last.message}</p>
            <p className="ui-note" style={{ margin: 0 }}>
              Check the connection step (press Back, then Test my proxies) and the account&apos;s password, then press Test again. If it keeps failing,
              finish the setup and use Help → Copy diagnostics to ask on our Discord.
            </p>
          </div>
        )}
      </div>
      {error && <p className="ui-msg bad" role="alert">{error}</p>}
    </>
  );
}

function Done({ heading }: { heading: HeadingRef }) {
  return (
    <>
      <h2 id="setup-title" ref={heading} tabIndex={-1}>You&apos;re all set</h2>
      <p>Your node is running. Bots log in by themselves when someone wants to trade, and log out afterwards.</p>
      <ul className="setup-what">
        <li><b>Closing the window does not stop the node.</b> It keeps running in the tray, the small icons near the clock. Click the icon to open it again.</li>
        <li><b>To stop it,</b> right-click the tray icon and choose <b>Quit</b>. That logs every bot out.</li>
        <li><b>If something needs you,</b> the control panel&apos;s status card says so, with a button to fix it.</li>
      </ul>
      <DesktopSettings />
    </>
  );
}
