"use client";

// A name with a copy button beside it (a party name to paste into the game's
// party finder). The clipboard API needs a secure context; when it is not
// there the button selects the text so a manual copy still works.
import { useRef, useState } from "react";

export default function CopyText({ text, title = "Copy" }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      const el = ref.current;
      if (el && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }
  return (
    <span className="copy-text">
      <b ref={ref}>{text}</b>
      <button type="button" className="copy-btn" title={title} aria-label={`${title}: ${text}`} onClick={() => void copy()}>{done ? "copied" : "copy"}</button>
    </span>
  );
}
