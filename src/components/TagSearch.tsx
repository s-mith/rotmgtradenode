import { useEffect, useMemo, useRef, useState } from "react";
import { effectLabel, effectsOfEnchant } from "@/lib/enchantEffects";
import { ItemSprite } from "./ItemSprite";

// --- Search tags -----------------------------------------------------------
// The pool search is a tag box: pick an item, an enchantment, or an effect
// ("adds Loot Boost") from the suggestions and it becomes a chip. Chips of
// different kinds AND together; item chips OR with each other (a list of
// items to show), enchant and effect chips must ALL be on the instance.
export type SearchTag =
  | { kind: "item"; id: string; label: string }
  | { kind: "ench"; name: string; label: string }
  | { kind: "effect"; key: string; label: string };

export const tagKey = (t: SearchTag) =>
  t.kind === "item" ? `item:${t.id}` : t.kind === "ench" ? `ench:${t.name}` : `effect:${t.key}`;

// Effect keys ("+Attack", "-MP Cost", …) live in lib/enchantEffects.ts so the
// server-side offer matcher shares them; re-exported for the pool UI.
export { effectsOfEnchant, effectLabel } from "@/lib/enchantEffects";

// Does an instance with these enchantments satisfy every tag? `itemId` is
// checked against the item chips (any of them), enchant and effect chips
// must all be present.
export function matchesTags(
  tags: SearchTag[],
  itemId: string,
  enchantments: { id: number; name: string | null }[],
): boolean {
  let anyItem = false;
  let itemOk = false;
  for (const t of tags) {
    if (t.kind === "item") {
      anyItem = true;
      if (t.id === itemId) itemOk = true;
    } else if (t.kind === "ench") {
      if (!enchantments.some((e) => (e.name ?? `Enchant #${e.id}`) === t.name)) return false;
    } else {
      if (!enchantments.some((e) => effectsOfEnchant(e.id).includes(t.key))) return false;
    }
  }
  return !anyItem || itemOk;
}

// Suggestion groups the box offers. Each already excludes tags in use.
export type Suggestions = {
  items: { id: string; name: string }[];
  enchants: string[];
  effects: string[]; // effect keys
};

const MAX_PER_GROUP = 8;
// Items get a longer list; the suggestion box scrolls.
const MAX_ITEMS = 100;

// Every typed word must appear somewhere in the name, in any order, so
// "health potion" finds "Potion of Health3". Names that start with the typed
// text come first, then names holding it as one piece, then the rest.
function searchRank(name: string, q: string, words: string[]): number {
  const n = name.toLowerCase();
  if (!words.every((w) => n.includes(w))) return -1;
  return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2;
}

export function TagSearch({
  tags,
  onTagsChange,
  text,
  onTextChange,
  suggestions,
  placeholder,
}: {
  tags: SearchTag[];
  onTagsChange: (tags: SearchTag[]) => void;
  text: string;
  onTextChange: (text: string) => void;
  suggestions: Suggestions;
  placeholder: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);

  // Filter each group by the typed text and flatten for keyboard navigation.
  const q = text.trim().toLowerCase();
  const rows = useMemo<SearchTag[]>(() => {
    const words = q.split(/\s+/).filter(Boolean);
    const items = suggestions.items
      .map((i) => ({ i, rank: q ? searchRank(i.name, q, words) : 0 }))
      .filter((r) => r.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((r) => r.i)
      .slice(0, MAX_ITEMS)
      .map((i): SearchTag => ({ kind: "item", id: i.id, label: i.name }));
    const enchants = suggestions.enchants
      .filter((n) => !q || n.toLowerCase().includes(q))
      .slice(0, MAX_PER_GROUP)
      .map((n): SearchTag => ({ kind: "ench", name: n, label: n }));
    const effects = suggestions.effects
      .map((k) => ({ k, label: effectLabel(k) }))
      .filter((e) => !q || e.label.toLowerCase().includes(q) || e.k.toLowerCase().includes(q))
      .slice(0, MAX_PER_GROUP)
      .map((e): SearchTag => ({ kind: "effect", key: e.k, label: e.label }));
    return [...items, ...enchants, ...effects];
  }, [suggestions, q]);

  useEffect(() => {
    setCursor(0);
  }, [rows]);

  // Keep the arrow-key row in view as the list scrolls.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".tag-suggest-row.active")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Suggestions show once there's something to narrow by: typed text, or a
  // tag already in place (so picking "Doom Bow" immediately lists its enchants).
  const open = focused && rows.length > 0 && (q.length > 0 || tags.length > 0);

  const add = (t: SearchTag) => {
    if (tags.some((x) => tagKey(x) === tagKey(t))) return;
    onTagsChange([...tags, t]);
    onTextChange("");
    inputRef.current?.focus();
  };
  const removeAt = (i: number) => {
    onTagsChange(tags.filter((_, j) => j !== i));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && text === "" && tags.length > 0) {
      e.preventDefault();
      removeAt(tags.length - 1);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      const row = rows[cursor];
      if (row) {
        e.preventDefault();
        add(row);
      }
    } else if (e.key === "Escape") {
      setFocused(false);
      inputRef.current?.blur();
    }
  };

  // Group headers are rendered when the kind changes between rows.
  let lastKind: SearchTag["kind"] | null = null;

  return (
    <div className={"tag-search" + (open ? " open" : "")}>
      <div
        className={"tag-search-box" + (focused ? " focused" : "")}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((t, i) => (
          <span key={tagKey(t)} className={"tag-chip tag-" + t.kind}>
            {t.kind === "item" && <ItemSprite name={t.label} size={18} />}
            <span className="tag-chip-label">{t.label}</span>
            <button
              type="button"
              className="tag-chip-x"
              aria-label={`Remove ${t.label}`}
              onClick={(e) => {
                e.stopPropagation();
                removeAt(i);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="tag-search-input"
          placeholder={tags.length === 0 ? placeholder : ""}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
        />
      </div>
      {open && (
        <ul
          ref={listRef}
          className="tag-suggest"
          role="listbox"
          // Keep the input focused while clicking a row.
          onMouseDown={(e) => e.preventDefault()}
        >
          {rows.map((row, i) => {
            const header = row.kind !== lastKind ? row.kind : null;
            lastKind = row.kind;
            return (
              <li key={tagKey(row)}>
                {header && (
                  <div className="tag-suggest-head">
                    {header === "item" ? "Items" : header === "ench" ? "Enchantments" : "Effects"}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  className={"tag-suggest-row tag-" + row.kind + (i === cursor ? " active" : "")}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => add(row)}
                >
                  {row.kind === "item" && <ItemSprite name={row.label} size={18} />}
                  <span>{row.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
