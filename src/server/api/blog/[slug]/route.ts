import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { getPost } from "@/lib/blog";

// GET /api/blog/<slug> — one published post (a permalink target).
export async function GET(_req: Request, ctx: { params: { slug: string } }) {
  const post = getPost(getDb(), ctx.params.slug);
  if (!post) return json({ error: "No such post" }, { status: 404 });
  const { slug, title, date, body, updatedAt } = post;
  return json({ ok: true, post: { slug, title, date, body, updatedAt } }, { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } });
}
