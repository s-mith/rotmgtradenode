import { useState } from "react";
import { ownInternet } from "./api";

// "Use my own internet": bots log in from this computer's connection, one at
// a time, instead of through proxies. It is the owner's call, so it is never
// on until they have read what it risks and ticked the box.

export function OwnInternetRisk() {
  return (
    <div className="ui-note">
      <p>
        Your bots will log in from <b>this computer&apos;s own internet connection</b>, one bot at a time. It costs nothing, but Realm then
        sees your bots and your main account coming from the same home address. If Realm bans a bot, it can notice that address too.
      </p>
      <p>Proxies avoid this. If you are unsure, use proxies.</p>
    </div>
  );
}

export default function OwnInternet({ allowed, onChange }: { allowed: boolean; onChange?: (allowed: boolean) => void }) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function set(allow: boolean) {
    setBusy(true);
    setError("");
    const r = await ownInternet(allow, allow ? understood : false);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onChange?.(allow);
  }

  if (allowed) {
    return (
      <div>
        <p className="ui-msg ok" role="status">Your own internet is allowed: one bot at a time logs in from this computer when no proxy is listed.</p>
        <button type="button" className="ui-btn small" disabled={busy} onClick={() => void set(false)}>
          {busy ? "…" : "Stop using my own internet"}
        </button>
        {error && <p className="ui-msg bad" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div>
      <OwnInternetRisk />
      <label className="ui-toggle">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>
          <b>I understand</b>
          <span className="ui-note">My home internet address will be used for the bots, and a ban could notice it.</span>
        </span>
      </label>
      <button type="button" className="ui-btn primary" disabled={busy || !understood} onClick={() => void set(true)}>
        {busy ? "…" : "Use my own internet"}
      </button>
      {error && <p className="ui-msg bad" role="alert">{error}</p>}
    </div>
  );
}
