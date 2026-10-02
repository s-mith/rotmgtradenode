import type { ReactNode } from "react";

// Just enough Markdown for the guide and the FAQ (docs/*.md), rendered as
// React elements (never raw HTML): headings, paragraphs, lists, quotes,
// **bold**, *italic*, `code` and [links](https://…). Images are left out:
// the screenshots live next to the docs on the website, not in the app.

const LIST = /^\s*(?:[-*]|\d+\.)\s+/;
const indentOf = (l: string) => /^\s*/.exec(l)![0].length;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[2] !== undefined) out.push(<b key={k}>{m[2]}</b>);
    else if (m[3] !== undefined) out.push(<i key={k}>{m[3]}</i>);
    else if (m[4] !== undefined) out.push(<code key={k}>{m[4]}</code>);
    else if (m[5] !== undefined) {
      const href = m[6];
      const external = /^https?:\/\//.test(href);
      // Only web links and anchors in the app; a link to another doc file has no page here.
      if (external) out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{m[5]}</a>);
      else if (href.startsWith("#") || href.startsWith("/")) out.push(<a key={k} href={href}>{m[5]}</a>);
      else out.push(<span key={k}>{m[5]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ source, id }: { source: string; id?: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^!\[[^\]]*\]\([^)]*\)\s*$/.test(line.trim())) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const k = key();
      const content = inline(h[2], k);
      blocks.push(level === 1 ? <h1 key={k}>{content}</h1> : level === 2 ? <h2 key={k}>{content}</h2> : <h3 key={k}>{content}</h3>);
      i++;
      continue;
    }
    if (LIST.test(line)) {
      // A list, with one level of nesting: a marker indented past the list's own starts a sub-list of the item above.
      const base = indentOf(line);
      const ordered = /^\s*\d+\.\s/.test(line);
      const start = ordered ? Number(/\d+/.exec(line)![0]) : 1;
      const items: { text: string; sub: { ordered: boolean; items: string[] } | null }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (LIST.test(l) && indentOf(l) <= base) {
          if (/^\s*\d+\.\s/.test(l) !== ordered) break;
          items.push({ text: l.replace(LIST, ""), sub: null });
          i++;
        } else if (LIST.test(l) && items.length) {
          const cur = items[items.length - 1];
          cur.sub ??= { ordered: /^\s*\d+\.\s/.test(l), items: [] };
          cur.sub.items.push(l.replace(LIST, ""));
          i++;
        } else if (/^\s{2,}\S/.test(l) && items.length) {
          // A wrapped line continues the item (or sub-item) above.
          const cur = items[items.length - 1];
          if (cur.sub) cur.sub.items[cur.sub.items.length - 1] += " " + l.trim();
          else cur.text += " " + l.trim();
          i++;
        } else break;
      }
      const k = key();
      const lis = items.map((it, j) => {
        const kk = `${k}-${j}`;
        const sub = it.sub && it.sub.items.map((s, x) => <li key={`${kk}-${x}`}>{inline(s, `${kk}-${x}`)}</li>);
        return (
          <li key={kk}>
            {inline(it.text, kk)}
            {sub && (it.sub!.ordered ? <ol>{sub}</ol> : <ul>{sub}</ul>)}
          </li>
        );
      });
      blocks.push(ordered ? <ol key={k} start={start}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      const k = key();
      blocks.push(<blockquote key={k}>{inline(quote.join(" "), k)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^>\s?/.test(lines[i])) para.push(lines[i++].trim());
    const k = key();
    blocks.push(<p key={k}>{inline(para.join(" "), k)}</p>);
  }
  return (
    <div className="md" id={id}>
      {blocks}
    </div>
  );
}
