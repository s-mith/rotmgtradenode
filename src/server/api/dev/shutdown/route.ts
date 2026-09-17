import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";

// POST /api/dev/shutdown — the desktop shell asks the node to stop the way a
// SIGTERM would (flush state, log the bots out). On Windows a child process
// cannot be signalled, so this is the only graceful path there.
export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const stop = globalThis.__rotmgtradenode_shutdown__;
  if (!stop) return json({ error: "no shutdown hook installed" }, { status: 503 });
  setTimeout(() => stop("shutdown request"), 50);
  return json({ ok: true });
}
