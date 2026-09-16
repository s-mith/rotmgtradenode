import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkDevPassword } from "@/lib/devauth";
import { deletePost } from "@/lib/blog";

// DELETE /api/dev/blog/<slug> — remove a post for good.
export async function DELETE(req: Request, ctx: { params: { slug: string } }) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const gone = deletePost(getDb(), ctx.params.slug);
  if (!gone) return json({ error: "No such post" }, { status: 404 });
  console.log(`[blog] deleted ${ctx.params.slug}`);
  return json({ ok: true });
}
