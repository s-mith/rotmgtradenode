import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { listPosts } from "@/lib/blog";

// GET /api/blog — published posts, newest first. Posts live in the database
// and are written from the operator console (see lib/blog.ts); the body is
// returned raw and the Blog component renders the small markdown subset
// we use.
export async function GET() {
  const posts = listPosts(getDb()).map(({ slug, title, date, body, updatedAt }) => ({ slug, title, date, body, updatedAt }));
  // Explicit no-store so an edge/CDN in front of the app can't pin a stale feed.
  return json({ ok: true, posts }, { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } });
}
