import { useState } from "react";
import { accountAdvice, addAccount } from "./api";

// Add one of the owner's alt accounts. Realm is asked about it on the spot
// (the password must work, the tutorial must be finished, it must not be
// suspended), so the answer here is final: added, or why not and what to do.

export function AddAccountHelp() {
  return (
    <div className="ui-note">
      <p>
        Use <b>alt accounts made just for this</b> — never your main account. Each one must have <b>finished the tutorial</b> in the game.
        Accounts that sign in with Steam, Google or Kongregate do not work: make a normal Realm account with an email and password.
      </p>
      <p>The password stays on this computer. After you add an account, the node reads what it holds; that takes a minute.</p>
    </div>
  );
}

export default function AddAccountForm({ onAdded, showHelp = true }: { onAdded?: () => void; showHelp?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const who = email.trim();
    setBusy(true);
    setMsg(null);
    const r = await addAccount(who, password);
    setBusy(false);
    if (!r.ok) {
      setMsg({ tone: "bad", text: accountAdvice(r.error) });
      return;
    }
    setMsg({ tone: "ok", text: `${who} is added. The node is reading it now.` });
    setEmail("");
    setPassword("");
    onAdded?.();
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Add an account">
      {showHelp && <AddAccountHelp />}
      <div className="ui-row" style={{ alignItems: "flex-end", marginTop: 8 }}>
        <div className="ui-field" style={{ marginBottom: 0, flex: "1 1 240px" }}>
          <label htmlFor="add-email">Email</label>
          <input id="add-email" className="ui-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" placeholder="alt@example.com" />
        </div>
        <div className="ui-field" style={{ marginBottom: 0, flex: "1 1 200px" }}>
          <label htmlFor="add-password">Password</label>
          <input id="add-password" className="ui-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <button type="submit" className="ui-btn primary" disabled={busy || !email.trim() || !password}>
          {busy ? "Checking with Realm…" : "Add account"}
        </button>
      </div>
      {msg && <p className={`ui-msg ${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p>}
    </form>
  );
}
