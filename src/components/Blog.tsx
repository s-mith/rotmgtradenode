
// Blog panel (right column, under the Leaderboard). Posts come from
// /api/blog (the database, edited in the operator console's Blog tab).
// The newest post shows expanded; older ones collapse to title + date and
// expand on click.
//
// Rendering: we support exactly the markdown subset the posts use —
// paragraphs (blank-line separated), "- " bullet lists, **bold**,
// *italic*, and [text](url) links — built as React elements, never
// innerHTML, so a malicious post file can't inject markup.

import { useEffect, useState } from "react";

type Post = { slug: string; title: string; date: string; body: string };

// Inline formatting: **bold**, *italic*, [text](url). One pass, left to
// right; unmatched markers render as literal text.
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={`${keyBase}-${k++}`}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={`${keyBase}-${k++}`}>{m[2]}</em>);
    else
      out.push(
        <a key={`${keyBase}-${k++}`} href={m[4]} target="_blank" rel="noopener noreferrer">
          {m[3]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function PostBody({ body, slug }: { body: string; slug: string }) {
  // Split into blocks on blank lines, then split each block into runs of
  // list lines ("- ") vs prose lines — a list doesn't need a blank line
  // before it, matching how people actually type markdown.
  const blocks = body.split(/\r?\n\s*\r?\n/).filter((b) => b.trim());
  const out: React.ReactNode[] = [];
  blocks.forEach((block, bi) => {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let run: { list: boolean; lines: string[] } | null = null;
    const runs: { list: boolean; lines: string[] }[] = [];
    for (const line of lines) {
      const isItem = line.startsWith("- ");
      if (!run || run.list !== isItem) {
        run = { list: isItem, lines: [] };
        runs.push(run);
      }
      run.lines.push(line);
    }
    runs.forEach((r, ri) => {
      const key = `${slug}-${bi}-${ri}`;
      if (r.list) {
        out.push(
          <ul key={key}>
            {r.lines.map((l, li) => (
              <li key={li}>{renderInline(l.slice(2), `${key}-${li}`)}</li>
            ))}
          </ul>,
        );
      } else {
        out.push(<p key={key}>{renderInline(r.lines.join(" "), key)}</p>);
      }
    });
  });
  return <div className="blog-body">{out}</div>;
}

export default function Blog() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [err, setErr] = useState(false);
  // Which post is expanded; the newest starts open once posts arrive.
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/blog", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { posts?: Post[] }) => {
        if (cancelled) return;
        const list = data.posts ?? [];
        setPosts(list);
        setOpenSlug(list[0]?.slug ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setPosts([]);
          setErr(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (posts === null) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  if (err || posts.length === 0)
    return <p style={{ color: "var(--muted)" }}>Nothing posted yet.</p>;

  return (
    <div className="blog">
      {posts.map((p) => {
        const open = p.slug === openSlug;
        return (
          <article className={"blog-post" + (open ? " open" : "")} key={p.slug}>
            <button
              type="button"
              className="blog-post-head"
              onClick={() => setOpenSlug(open ? null : p.slug)}
              aria-expanded={open}
            >
              <span className="blog-post-title">{p.title}</span>
              <span className="blog-post-date">{p.date}</span>
            </button>
            {open && <PostBody body={p.body} slug={p.slug} />}
          </article>
        );
      })}
    </div>
  );
}
