
import { useEffect, useState, useSyncExternalStore } from "react";
import { colorHex, type NameStyle } from "@/lib/cosmetics";
import { useNameStyle } from "@/lib/useNameStyle";

// Renders an IGN with its donator name effect (see lib/cosmetics.ts).
//
// Two ways to use it. Endpoints that already carry the style pass it in —
// `style={p.nameStyle}` — and nothing else happens. Anywhere else, omit the
// prop and the style is looked up and cached by lib/useNameStyle, with all
// the names mounting in one tick coalesced into a single request. Either
// way a player with no effect renders exactly the bare text it replaced,
// so this is safe to drop in everywhere a name is printed.
//
// Nothing here interpolates a caller string into markup or CSS: colours are
// looked up from the fixed 16-entry table by id, and every other knob is a
// boolean that toggles a class. A style row can't reach the DOM as anything
// but a class name and a hex from that table.
//
// Gradients use background-clip:text over the whole name rather than
// per-character spans the way MiniMessage does — visually the same across a
// 32-char IGN, one element instead of 32, and it animates for free.

// --- shared obfuscation ticker -------------------------------------------
// One timer for the whole page no matter how many §k names are on screen;
// a leaderboard of 50 would otherwise be 50 independent intervals. The
// timer only exists while something is subscribed.
const OBF_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&?!";
const listeners = new Set<() => void>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribeTick(fn: () => void): () => void {
  listeners.add(fn);
  if (timer === null) {
    timer = setInterval(() => {
      // Pause while the tab is hidden — nobody's watching the glyphs spin
      // and it keeps a backgrounded tab off the CPU.
      if (typeof document !== "undefined" && document.hidden) return;
      tick++;
      for (const l of listeners) l();
    }, 70);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noSubscribe = () => () => {};
const getTick = () => tick;
const getServerTick = () => 0;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function scramble(text: string): string {
  let out = "";
  for (const ch of text) {
    out += ch === " " ? " " : OBF_CHARS[(Math.random() * OBF_CHARS.length) | 0];
  }
  return out;
}

// MiniMessage's <rainbow>, as gradient stops. Ends on red again so the
// animated sweep loops without a seam.
const RAINBOW = "#ff5555, #ffaa00, #ffff55, #55ff55, #55ffff, #5555ff, #ff55ff, #ff5555";

export default function PlayerName({
  ign,
  style,
  className,
  readable = false,
}: {
  ign: string;
  /**
   * The effect to draw. Omit it to have the component look the style up
   * itself; pass it (null included) when the caller already knows, which
   * skips the lookup entirely.
   */
  style?: NameStyle | null;
  className?: string;
  /**
   * Draw the colour and formatting but never scramble the glyphs, even when
   * the player has §k on. For places whose whole job is telling the operator
   * WHO this is — the dev console's lists — where an unreadable name is a
   * bug, not a cosmetic. Player-facing views leave this off.
   */
  readable?: boolean;
}) {
  // `undefined` means "not told" — look it up. An explicit null means "this
  // player has no effect", which is an answer, not a missing prop.
  const looked = useNameStyle(style === undefined ? ign : null);
  const effective = style === undefined ? looked : style;

  const reduced = usePrefersReducedMotion();
  const obfuscating = Boolean(effective?.obfuscated) && !reduced && !readable;
  const t = useSyncExternalStore(
    obfuscating ? subscribeTick : noSubscribe,
    getTick,
    getServerTick,
  );

  if (!effective) return <>{ign}</>;

  // t === 0 on the first paint so server and client agree; scrambling only
  // starts once the ticker has actually fired.
  const text = obfuscating && t > 0 ? scramble(ign) : ign;

  const classes = ["mc-name"];
  if (effective.bold) classes.push("mc-bold");
  if (effective.italic) classes.push("mc-italic");
  if (effective.underline) classes.push("mc-underline");
  if (effective.strike) classes.push("mc-strike");
  // The monospace lock only earns its place while the glyphs are churning;
  // a readable name has no width to hold steady.
  if (effective.obfuscated && !readable) classes.push("mc-obf");
  if (className) classes.push(className);

  const css: React.CSSProperties = {};
  if (effective.effect === "solid") {
    css.color = colorHex(effective.color) ?? undefined;
  } else if (effective.effect === "gradient" || effective.effect === "rainbow") {
    const stops =
      effective.effect === "rainbow"
        ? RAINBOW
        : `${colorHex(effective.from) ?? "#fff"}, ${colorHex(effective.to) ?? "#fff"}`;
    css.backgroundImage = `linear-gradient(90deg, ${stops})`;
    classes.push("mc-fill");
    if (effective.animated) classes.push("mc-anim");
  }

  return (
    <span
      className={classes.join(" ")}
      style={css}
      // The real IGN stays reachable even when the glyphs are scrambled or
      // the colour is near-invisible against the panel: hover shows it, and
      // screen readers get it instead of the decoration.
      title={ign}
      aria-label={ign}
    >
      <span aria-hidden={obfuscating || undefined}>{text}</span>
    </span>
  );
}
