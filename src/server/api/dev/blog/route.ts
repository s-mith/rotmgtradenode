import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkDevPassword } from "@/lib/devauth";
import { listPosts, savePost, validatePost } from "@/lib/blog";

// Operator console: the blog editor.
//   GET  /api/dev/blog  — every post, drafts included, newest first
//   POST /api/dev/blog  — create or update: { slug?, title, date, body, published?, previousSlug? }
//                          slug defaults to one made from the title; previousSlug renames.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  return json({ ok: true, posts: listPosts(getDb(), { drafts: true }) });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "Bad JSON" }, { status: 400 });
  const v = validatePost(body);
  if (!v.ok) return json({ error: v.error }, { status: 400 });
  const previous = typeof body.previousSlug === "string" ? body.previousSlug : null;
  const saved = savePost(getDb(), v.post, previous);
  if (!saved.ok) return json({ error: saved.error }, { status: 409 });
  console.log(`[blog] ${previous && previous !== saved.post.slug ? `renamed ${previous} -> ` : "saved "}${saved.post.slug} (${saved.post.published ? "published" : "draft"})`);
  return json({ ok: true, post: saved.post });
}
