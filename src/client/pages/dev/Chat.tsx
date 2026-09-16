
import { useEffect, useRef, useState } from "react";

// DEV-ONLY fake RotMG chat, for testing the copy-paste login without the game.
// Set your character name up top, paste the "/tell <bot> …" line the site gave
// you, and hit send — it posts to the mock pyrelay's send-tell (standing in for
// the whisper reaching the bot), which verifies the code and logs you in on the
// site (its login panel is polling and will flip to "Logged in as <you>").
//
// Styled to loosely evoke Realm's chat box: dark, tells in magenta, system
// lines in gold. It's a test harness, not a faithful clone.

type Line = { id: number; kind: "tell" | "sys" | "chat"; text: string };

const COLORS: Record<Line["kind"], string> = {
  tell: "#ff6ad5",
  sys: "#e0b64a",
  chat: "#d8dbe2",
};

export default function DevChat() {
  const [ign, setIgn] = useState("TestComrade");
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { id: 0, kind: "sys", text: "VultureBee has entered the realm." },
    { id: 1, kind: "sys", text: 'Paste your "/tell VultureBee …" login line below and press Enter.' },
  ]);
  const nextId = useRef(2);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  function add(kind: Line["kind"], text: string) {
    setLines((cur) => [...cur, { id: nextId.current++, kind, text }]);
  }

  async function send() {
    const raw = input.trim();
    if (!raw) return;
    setInput("");

    const m = raw.match(/^\/tell\s+(\S+)\s+(.+)$/i);
    if (!m) {
      add("sys", "Usage: /tell <bot> <message>");
      return;
    }
    const [, recipient, message] = m;

    if (!/^[A-Za-z]{1,32}$/.test(ign)) {
      add("sys", "Set a valid character name (letters only) up top first.");
      return;
    }

    add("tell", `«To ${recipient}» ${message}`);
    try {
      const r = await fetch("/api/mock-pyrelay/dev/send-tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: ign, text: message }),
      });
      const d = await r.json();
      if (!r.ok) {
        add("sys", d.error || "The whisper bounced.");
      } else if (d.matched) {
        add("sys", `${recipient} received your login code — check the site, you should be logged in.`);
      } else {
        add("sys", `${recipient} didn't find a login code in that message.`);
      }
    } catch {
      add("sys", "Couldn't reach the bot (is the dev server up?).");
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "40px auto", padding: "0 16px", color: "#d8dbe2" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Fake Realm Chat</h1>
      <p style={{ color: "#9aa0ad", fontSize: 13, marginTop: 0 }}>
        Dev harness for the copy-paste login. Log in on the{" "}
        <a href="/" style={{ color: "#d4a13b" }}>
          main page
        </a>
        , copy the <code>/tell</code> line, paste it here, and send.
      </p>

      <label style={{ fontSize: 13, color: "#9aa0ad" }}>
        Your character:{" "}
        <input
          value={ign}
          onChange={(e) => setIgn(e.target.value)}
          maxLength={32}
          style={{
            background: "#1f222c",
            color: "#d8dbe2",
            border: "1px solid #2a2e3a",
            borderRadius: 4,
            padding: "4px 8px",
            font: "inherit",
          }}
        />
      </label>

      <div
        ref={logRef}
        style={{
          marginTop: 12,
          height: 320,
          overflowY: "auto",
          background: "rgba(10,11,15,0.92)",
          border: "1px solid #2a2e3a",
          borderRadius: 8,
          padding: 12,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {lines.map((l) => (
          <div key={l.id} style={{ color: COLORS[l.kind] }}>
            {l.text}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        style={{ display: "flex", gap: 8, marginTop: 10 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="/tell VultureBee by pasting this im logging into rotmgcommunism …"
          style={{
            flex: 1,
            background: "#1f222c",
            color: "#d8dbe2",
            border: "1px solid #2a2e3a",
            borderRadius: 6,
            padding: "8px 10px",
            font: "inherit",
          }}
        />
        <button
          type="submit"
          style={{
            background: "#d4a13b",
            color: "#000",
            border: 0,
            borderRadius: 6,
            padding: "8px 16px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
