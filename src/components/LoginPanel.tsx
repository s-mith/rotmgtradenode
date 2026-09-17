import { useCallback, useEffect, useRef, useState } from "react";

// Login by copy-pasted /tell. The player clicks Log in, we mint a code and show
// "/tell <bot> <code>"; they paste it in game, and the tell landing at the bot
// from their character proves control (see lib/login.ts). We poll until pyrelay
// reports it verified, then the session cookie is set and `ign` flips on.
//
// The same handshake links a further character to the account once logged in
// (`link: true` on the status poll): the new name joins the list below, the
// session keeps acting as the character it was on, and the player can switch
// between linked names without pasting again.
//
// `ign` (the verified session IGN, or null) is owned by the parent so the trade
// form can read it too; this panel just drives the handshake and reports the
// result up through `onChange`.
type Linked = { ign: string; linkedAt: number };

export default function LoginPanel({
  ign,
  onChange,
}: {
  ign: string | null;
  onChange: (ign: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<{ code: string; botIgn: string; link: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [igns, setIgns] = useState<Linked[]>([]);
  const [accountBusy, setAccountBusy] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;


  // The account's linked characters, whenever the acting character changes.
  useEffect(() => {
    if (!ign) {
      setIgns([]);
      return;
    }
    let cancelled = false;
    fetch("/api/login/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { igns?: Linked[] }) => {
        if (!cancelled) setIgns(d.igns ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ign]);

  async function start(link: boolean) {
    setErr(null);
    setNotice(null);
    setCopied(false);
    setBusy(true);
    try {
      const r = await fetch("/api/login/start", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Couldn't start login.");
        return;
      }
      setChallenge({ code: d.code, botIgn: d.botIgn, link });
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  const logout = useCallback(async () => {
    await fetch("/api/login/logout", { method: "POST" }).catch(() => {});
    onChangeRef.current(null);
  }, []);

  async function account(path: "switch" | "unlink", target: string) {
    setErr(null);
    setNotice(null);
    setAccountBusy(true);
    try {
      const r = await fetch(`/api/account/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ign: target }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Couldn't update the account.");
        return;
      }
      setIgns(d.igns ?? []);
      if (path === "unlink") setNotice(`Unlinked ${target}.`);
      if (d.ign && d.ign !== ign) onChangeRef.current(d.ign);
    } catch {
      setErr("Network error.");
    } finally {
      setAccountBusy(false);
    }
  }

  const tellCmd = challenge
    ? `/tell ${challenge.botIgn} by pasting this im logging into rotmgcommunism ${challenge.code}`
    : "";

  // Poll for the pasted tell while a challenge is live.
  useEffect(() => {
    if (!challenge) return;
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/login/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: challenge.code, link: challenge.link }),
        });
        const d = await r.json();
        if (stopped) return;
        if (r.ok && d.state === "verified") {
          setChallenge(null);
          if (challenge.link) {
            setIgns(d.igns ?? []);
            setNotice(`Linked ${d.linked}. Switch to it below whenever you're playing on that account.`);
          } else {
            onChangeRef.current(d.ign);
          }
        } else if (!r.ok && d.state === "verified") {
          // The tell landed but the name couldn't be linked (it has a vault of
          // its own, say). The code is spent either way.
          setChallenge(null);
          setErr(d.error || "Couldn't link that character.");
        } else if (r.ok && d.state === "expired") {
          setChallenge(null);
          setErr("That code expired — start again.");
        }
      } catch {
        // transient; keep polling
      }
    }, 2500);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [challenge]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(tellCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the player can still select the text manually
    }
  }

  const challengeBox = challenge && (
    <div className="login-link-challenge">
      <p className="login-intro">
        {challenge.link
          ? "Log into the account you want to add and paste this — the whisper has to come from that account."
          : "Paste this in game to prove it’s you — the whisper has to come from your character."}
      </p>
      <div className="login-tell">
        <code className="login-tell-cmd">{tellCmd}</code>
        <button type="button" className="login-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="login-status">Waiting for your whisper…</p>
      <button type="button" className="login-secondary" onClick={() => setChallenge(null)}>
        Cancel
      </button>
    </div>
  );

  if (ign) {
    return (
      <div className="login">
        {/* Every character on this account. The session acts as one of them at
            a time; switching re-mints the cookie for that name, no new /tell. */}
        <div className="login-chars">
          <div className="login-chars-head">
            <span className="login-chars-title">Accounts</span>
            {!challenge && (
              <button type="button" className="login-secondary" onClick={() => start(true)} disabled={busy || accountBusy}>
                {busy ? "Starting…" : "Link another"}
              </button>
            )}
          </div>
          <ul className="login-char-list">
            {(igns.length ? igns : [{ ign, linkedAt: 0 }]).map((c) => {
              const active = c.ign.toLowerCase() === ign.toLowerCase();
              return (
                <li key={c.ign.toLowerCase()} className={"login-char" + (active ? " login-char-active" : "")}>
                  <span className="login-char-name">
                    {c.ign}
                    {active && <span className="login-char-tag">acting as</span>}
                  </span>
                  <span className="login-char-actions">
                    {!active && (
                      <button type="button" className="login-char-btn" disabled={accountBusy} onClick={() => account("switch", c.ign)}>
                        Switch
                      </button>
                    )}
                    {igns.length > 1 && (
                      <button
                        type="button"
                        className="login-char-btn login-char-btn-danger"
                        disabled={accountBusy}
                        onClick={() => {
                          if (confirm(`Unlink ${c.ign}? Its items stay in this vault; that account can log in on its own again.`)) void account("unlink", c.ign);
                        }}
                      >
                        Unlink
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {challengeBox}
        </div>

        <button type="button" className="login-secondary" onClick={logout}>
          Log out
        </button>
        {notice && <p className="login-status">{notice}</p>}
        {err && <p className="login-err">{err}</p>}
      </div>
    );
  }

  if (challenge) {
    return (
      <div className="login">
        {challengeBox}
        {err && <p className="login-err">{err}</p>}
      </div>
    );
  }

  return (
    <div className="login">
      <p className="login-intro">
        Log in with your in-game character to deposit and withdraw.
        You&rsquo;ll paste one <code>/tell</code> command — no password.
      </p>
      <button type="button" className="login-primary" onClick={() => start(false)} disabled={busy}>
        {busy ? "Starting…" : "Log in"}
      </button>
      {err && <p className="login-err">{err}</p>}
    </div>
  );
}
