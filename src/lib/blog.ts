// Blog posts: stored in the site database, written from the operator
// console, served by /api/blog. The body is markdown in the small subset
// the Blog component renders (paragraphs, "- " lists, **bold**, *italic*,
// [text](url)); the renderer builds React elements, never HTML, so the body
// needs no sanitising here.
//
// Posts used to be files in content/blog/*.md baked into the image, which
// made every post a redeploy (and a fleet restart). Those files are imported
// once, on the first read after boot, for any slug the database doesn't
// have; after that the database is the source of truth and the files are
// just seed data.
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export type Post = { slug: string; title: string; date: string; body: string };
export type StoredPost = Post & { published: boolean; createdAt: number; updatedAt: number };

export const MAX_TITLE = 120;
export const MAX_SLUG = 80;
export const MAX_BODY = 64 * 1024;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Row = { slug: string; title: string; date: string; body: string; published: number; created_at: number; updated_at: number };
const fromRow = (r: Row): StoredPost => ({ slug: r.slug, title: r.title, date: r.date, body: r.body, published: r.published === 1, createdAt: r.created_at, updatedAt: r.updated_at });

/** "The pool is people!" -> "the-pool-is-people". */
export function slugify(title: string): string {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG).replace(/-+$/, "");
}

export type PostInput = { slug?: unknown; title?: unknown; date?: unknown; body?: unknown; published?: unknown };
export type Validated = { ok: true; post: Post & { published: boolean } } | { ok: false; error: string };

export function validatePost(input: PostInput): Validated {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return { ok: false, error: "Title is required" };
  if (title.length > MAX_TITLE) return { ok: false, error: `Title must be at most ${MAX_TITLE} characters` };
  const date = typeof input.date === "string" ? input.date.trim() : "";
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) return { ok: false, error: "Date must be YYYY-MM-DD" };
  const slug = typeof input.slug === "string" && input.slug.trim() ? input.slug.trim() : slugify(title);
  if (!slug || slug.length > MAX_SLUG || !SLUG_RE.test(slug)) return { ok: false, error: "Slug must be lowercase letters, digits and dashes" };
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").trim() : "";
  if (body.length > MAX_BODY) return { ok: false, error: `Body must be at most ${MAX_BODY} characters` };
  const published = input.published === undefined ? true : Boolean(input.published);
  return { ok: true, post: { slug, title, date, body, published } };
}

/** Published posts, newest first (slug breaks date ties, newest slug first). */
export function listPosts(db: Database.Database, opts: { drafts?: boolean } = {}): StoredPost[] {
  ensureSeeded(db);
  const rows = db
    .prepare(`SELECT slug, title, date, body, published, created_at, updated_at FROM blog_posts ${opts.drafts ? "" : "WHERE published = 1"} ORDER BY date DESC, slug DESC`)
    .all() as Row[];
  return rows.map(fromRow);
}

export function getPost(db: Database.Database, slug: string, opts: { drafts?: boolean } = {}): StoredPost | null {
  ensureSeeded(db);
  const row = db.prepare("SELECT slug, title, date, body, published, created_at, updated_at FROM blog_posts WHERE slug = ?").get(slug) as Row | undefined;
  if (!row) return null;
  const post = fromRow(row);
  return post.published || opts.drafts ? post : null;
}

/**
 * Create or update a post. `previousSlug` renames: the old row goes, the new
 * one takes its creation time. Fails if the new slug belongs to another post.
 */
export function savePost(db: Database.Database, post: Post & { published: boolean }, previousSlug?: string | null): { ok: true; post: StoredPost } | { ok: false; error: string } {
  ensureSeeded(db);
  const now = Date.now();
  const from = previousSlug && previousSlug !== post.slug ? previousSlug : null;
  const out = db.transaction((): { ok: true; post: StoredPost } | { ok: false; error: string } => {
    const existing = db.prepare("SELECT created_at FROM blog_posts WHERE slug = ?").get(post.slug) as { created_at: number } | undefined;
    if (from) {
      if (existing) return { ok: false, error: `A post with slug "${post.slug}" already exists` };
      const old = db.prepare("SELECT created_at FROM blog_posts WHERE slug = ?").get(from) as { created_at: number } | undefined;
      if (!old) return { ok: false, error: "The post being renamed no longer exists" };
      db.prepare("DELETE FROM blog_posts WHERE slug = ?").run(from);
      db.prepare("INSERT INTO blog_posts (slug, title, date, body, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(post.slug, post.title, post.date, post.body, post.published ? 1 : 0, old.created_at, now);
    } else if (existing) {
      db.prepare("UPDATE blog_posts SET title = ?, date = ?, body = ?, published = ?, updated_at = ? WHERE slug = ?")
        .run(post.title, post.date, post.body, post.published ? 1 : 0, now, post.slug);
    } else {
      db.prepare("INSERT INTO blog_posts (slug, title, date, body, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(post.slug, post.title, post.date, post.body, post.published ? 1 : 0, now, now);
    }
    return { ok: true, post: getPost(db, post.slug, { drafts: true })! };
  }).immediate();
  return out;
}

export function deletePost(db: Database.Database, slug: string): boolean {
  ensureSeeded(db);
  return db.prepare("DELETE FROM blog_posts WHERE slug = ?").run(slug).changes === 1;
}

// --- seed from the old content/blog files ------------------------------------

/**
 * A legacy post file: a tiny front-matter block, then the body.
 *   ---
 *   title: The pool is people
 *   date: 2026-07-07
 *   ---
 *   body…
 */
export function parsePostFile(slug: string, raw: string): Post | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = new Map<string, string>();
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const title = meta.get("title");
  const date = meta.get("date");
  if (!title || !date || !DATE_RE.test(date)) return null;
  return { slug, title, date, body: m[2].trim() };
}

/** Insert every parseable file whose slug the table lacks; returns how many were added. */
export function importPostsFromDir(db: Database.Database, dir: string): number {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return 0;
  }
  const insert = db.prepare("INSERT OR IGNORE INTO blog_posts (slug, title, date, body, published, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)");
  let added = 0;
  const run = db.transaction(() => {
    for (const f of files) {
      let post: Post | null = null;
      try {
        post = parsePostFile(f.replace(/\.md$/, ""), fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        continue;
      }
      if (!post) continue;
      // File slugs were free-form names; keep them as they were so links survive.
      const slug = post.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG) || slugify(post.title);
      const at = Number.isNaN(Date.parse(post.date)) ? Date.now() : Date.parse(post.date);
      added += insert.run(slug, post.title, post.date, post.body, at, at).changes;
    }
  });
  run();
  return added;
}

const seeded = new WeakSet<Database.Database>();
export const LEGACY_DIR = path.join(process.cwd(), "content", "blog");
/** Once per database per process: pull in the legacy files. */
export function ensureSeeded(db: Database.Database, dir = LEGACY_DIR): void {
  if (seeded.has(db)) return;
  seeded.add(db);
  const added = importPostsFromDir(db, dir);
  if (added) console.log(`[blog] imported ${added} post(s) from ${dir}`);
}
