
import { useEffect, useState } from "react";
import PlayerName from "./PlayerName";
import { primeNameStyle } from "@/lib/useNameStyle";
import {
  DEFAULT_STYLE,
  EFFECTS,
  MC_COLORS,
  type EffectId,
  type McColorId,
  type NameStyle,
} from "@/lib/cosmetics";

// Donator name-effect menu, shown inside the logged-in login card. Mounted
// only when /api/cosmetics reports a live grant, so non-donators never see
// it — but the grant is re-checked on save (POST /api/cosmetics), which is
// what actually enforces it.
//
// Edits are local until Save, with the preview rendered by the same
// PlayerName component the leaderboard uses, so what you see is literally
// what everyone else will get.

const EFFECT_LABELS: Record<EffectId, string> = {
  plain: "None",
  solid: "Solid",
  gradient: "Gradient",
  rainbow: "Rainbow",
};

type Toggle = "bold" | "italic" | "underline" | "strike" | "obfuscated";

const TOGGLES: { key: Toggle; label: string; title: string }[] = [
  { key: "bold", label: "Bold", title: "§l" },
  { key: "italic", label: "Italic", title: "§o" },
  { key: "underline", label: "Underline", title: "§n" },
  { key: "strike", label: "Strike", title: "§m" },
  { key: "obfuscated", label: "Obfuscated", title: "§k — scrambles the glyphs; hovering still shows your real name" },
];

function Swatches({
  value,
  onPick,
}: {
  value: McColorId;
  onPick: (c: McColorId) => void;
}) {
  return (
    <>
      {MC_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          className="mc-swatch"
          style={{ background: c.hex }}
          aria-pressed={value === c.id}
          aria-label={c.label}
          title={`${c.label} (§${c.code})`}
          onClick={() => onPick(c.id)}
        />
      ))}
    </>
  );
}

export default function NameCustomizer({
  ign,
  onSaved,
}: {
  ign: string;
  /** Saved successfully — the page should repaint this player's name. */
  onSaved?: () => void;
}) {
  // null while we're still asking whether this account has effects at all.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<NameStyle>(DEFAULT_STYLE);
  const [saved, setSaved] = useState<NameStyle>(DEFAULT_STYLE);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/cosmetics", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setEnabled(Boolean(d.enabled));
        const s = (d.style ?? DEFAULT_STYLE) as NameStyle;
        setStyle(s);
        setSaved(s);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ign]);

  if (enabled !== true) return null;

  const dirty = JSON.stringify(style) !== JSON.stringify(saved);
  const set = (patch: Partial<NameStyle>) => {
    setStyle((s) => ({ ...s, ...patch }));
    setNote(null);
  };

  async function save() {
    setSaving(true);
    setErr(null);
    setNote(null);
    try {
      const r = await fetch("/api/cosmetics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || `HTTP ${r.status}`);
        return;
      }
      // Trust the server's echo — it re-validates, so this is the style
      // everyone else will actually see.
      setStyle(d.style);
      setSaved(d.style);
      // Push it into the shared cache so every PlayerName for this IGN
      // repaints now, with no refetch and no flash of the old style.
      primeNameStyle(ign, d.style);
      // And let the feeds that embed the style server-side reload.
      onSaved?.();
      setNote("Saved.");
    } catch {
      setErr("Network error.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="mc-menu">
        <button type="button" className="login-secondary" onClick={() => setOpen(true)}>
          Customize name
        </button>
      </div>
    );
  }

  return (
    <div className="mc-menu">
      <div className="mc-preview">
        <PlayerName ign={ign} style={style} />
      </div>

      <div className="mc-row">
        <span className="mc-row-label">Effect</span>
        {EFFECTS.map((e) => (
          <button
            key={e}
            type="button"
            className="mc-chip"
            aria-pressed={style.effect === e}
            onClick={() => set({ effect: e })}
          >
            {EFFECT_LABELS[e]}
          </button>
        ))}
      </div>

      {style.effect === "solid" && (
        <div className="mc-row">
          <span className="mc-row-label">Colour</span>
          <Swatches value={style.color} onPick={(color) => set({ color })} />
        </div>
      )}

      {style.effect === "gradient" && (
        <>
          <div className="mc-row">
            <span className="mc-row-label">Gradient from</span>
            <Swatches value={style.from} onPick={(from) => set({ from })} />
          </div>
          <div className="mc-row">
            <span className="mc-row-label">Gradient to</span>
            <Swatches value={style.to} onPick={(to) => set({ to })} />
          </div>
        </>
      )}

      {(style.effect === "gradient" || style.effect === "rainbow") && (
        <div className="mc-row">
          <button
            type="button"
            className="mc-chip"
            aria-pressed={style.animated}
            onClick={() => set({ animated: !style.animated })}
          >
            Animate the sweep
          </button>
        </div>
      )}

      <div className="mc-row">
        <span className="mc-row-label">Formatting</span>
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            type="button"
            className="mc-chip"
            title={t.title}
            aria-pressed={style[t.key]}
            onClick={() => set({ [t.key]: !style[t.key] } as Partial<NameStyle>)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mc-menu-actions">
        <button
          type="button"
          className="login-primary"
          onClick={save}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
        <button
          type="button"
          className="login-secondary"
          onClick={() => {
            setStyle(saved);
            setOpen(false);
            setErr(null);
            setNote(null);
          }}
        >
          Close
        </button>
        <button
          type="button"
          className="login-secondary"
          onClick={() => set(DEFAULT_STYLE)}
        >
          Reset
        </button>
      </div>

      {err && <p className="login-err">{err}</p>}
      {note && !err && <p className="mc-menu-note">{note}</p>}
    </div>
  );
}
