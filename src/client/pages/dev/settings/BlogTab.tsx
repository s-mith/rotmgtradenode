// Operator console: write and edit blog posts. Left: every post, drafts
// marked. Right: the editor with a live preview rendered by the same
// component the public blog uses, so what you see is what ships.
import { useCallback, useEffect, useState } from "react";
import { PostBody } from "../../../../components/Blog";

type StoredPost = { slug: string; title: string; date: string; body: string; published: boolean; createdAt: number; updatedAt: number };
type Draft = { slug: string; title: string; date: string; body: string; published: boolean };

const today = () => new Date().toISOString().slice(0, 10);
const slugify = (title: string) => title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
const blank = (): Draft => ({ slug: "", title: "", date: today(), body: "", published: false });

export default function BlogTab({ password }: { password: string }) {
  const [posts, setPosts] = useState<StoredPost[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** Slug of the post being edited, or null for a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  /** Until the slug is typed by hand it follows the title. */
  const [slugTouched, setSlugTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const headers = { "Content-Type": "application/json", "x-dev-password": password };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/blog", { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setPosts(data.posts as StoredPost[]);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    load();
  }, [load]);

  function open(p: StoredPost | null) {
    setEditing(p ? p.slug : null);
    setDraft(p ? { slug: p.slug, title: p.title, date: p.date, body: p.body, published: p.published } : blank());
    setSlugTouched(!!p);
    setConfirmDelete(false);
    setNotice("");
    setError("");
  }

  function setTitle(title: string) {
    setDraft((d) => ({ ...d, title, slug: slugTouched ? d.slug : slugify(title) }));
  }

  async function save(publish?: boolean) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = { ...draft, published: publish ?? draft.published, previousSlug: editing };
      const r = await fetch("/api/dev/blog", { method: "POST", headers, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      const saved = data.post as StoredPost;
      setEditing(saved.slug);
      setDraft({ slug: saved.slug, title: saved.title, date: saved.date, body: saved.body, published: saved.published });
      setNotice(saved.published ? "Published." : "Saved as a draft.");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/dev/blog/${encodeURIComponent(editing)}`, { method: "DELETE", headers: { "x-dev-password": password } });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      open(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = (() => {
    if (!editing) return draft.title.trim() !== "" || draft.body.trim() !== "";
    const p = posts?.find((x) => x.slug === editing);
    return !p || p.title !== draft.title || p.slug !== draft.slug || p.date !== draft.date || p.body !== draft.body || p.published !== draft.published;
  })();

  return (
    <section>
      <div className="blog-editor">
        <aside className="blog-editor-list">
          <button type="button" className="btn" onClick={() => open(null)} disabled={saving}>
            + New post
          </button>
          {posts === null && <p style={{ color: "var(--muted)" }}>Loading…</p>}
          {posts?.length === 0 && <p style={{ color: "var(--muted)" }}>No posts yet.</p>}
          {posts?.map((p) => (
            <button
              type="button"
              key={p.slug}
              className={"blog-editor-item" + (p.slug === editing ? " active" : "")}
              onClick={() => open(p)}
            >
              <span className="blog-editor-item-title">{p.title || p.slug}</span>
              <span className="blog-editor-item-meta">
                {p.date}
                {!p.published && <span className="blog-editor-draft">draft</span>}
              </span>
            </button>
          ))}
        </aside>

        <div className="blog-editor-form">
          <label>
            Title
            <input value={draft.title} onChange={(e) => setTitle(e.target.value)} placeholder="What's new" maxLength={120} />
          </label>
          <div className="blog-editor-row">
            <label>
              Slug
              <input
                value={draft.slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setDraft((d) => ({ ...d, slug: e.target.value }));
                }}
                placeholder="made-from-the-title"
                maxLength={80}
              />
            </label>
            <label>
              Date
              <input type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
            </label>
          </div>
          <label>
            Body
            <textarea
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              placeholder={"Paragraphs separated by a blank line. **bold**, *italic*, [link](https://…), and lines starting with \"- \" for a list."}
              spellCheck
            />
          </label>
          <div className="blog-editor-actions">
            <button type="button" className="btn" onClick={() => save(false)} disabled={saving || !dirty && !draft.published}>
              {draft.published ? "Unpublish (keep as draft)" : "Save draft"}
            </button>
            <button type="button" className="btn primary" onClick={() => save(true)} disabled={saving || (!dirty && draft.published)}>
              {draft.published ? "Save changes" : "Publish"}
            </button>
            {editing && (
              <button type="button" className="btn danger" onClick={remove} disabled={saving}>
                {confirmDelete ? "Really delete?" : "Delete"}
              </button>
            )}
            {editing && (
              <a className="blog-editor-link" href={`/api/blog/${encodeURIComponent(editing)}`} target="_blank" rel="noopener noreferrer">
                permalink
              </a>
            )}
          </div>
          {error && <p className="blog-editor-error">{error}</p>}
          {notice && <p className="blog-editor-notice">{notice}</p>}
        </div>

        <div className="blog-editor-preview">
          <div className="blog">
            <article className="blog-post open">
              <div className="blog-post-head">
                <span className="blog-post-title">{draft.title || "Untitled"}</span>
                <span className="blog-post-date">{draft.date}</span>
              </div>
              {draft.body.trim() ? <PostBody body={draft.body} slug={draft.slug || "preview"} /> : <p className="blog-body" style={{ color: "var(--muted)" }}>Nothing written yet.</p>}
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
