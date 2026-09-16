import { json } from "@/server/http";
import { accountgen, checkDevPassword, pyrelay } from "@/lib/devauth";

// POST /api/dev/accounts — the owner adds one of their own accounts.
//
// { email, password, seasonal, tutorialDone, alias? }
//
// tutorialDone=true: the account has a character past the tutorial, so it
// goes straight onto the roster and the fleet may log it in. Otherwise it
// goes to the onboarding service, which walks the tutorial and hands it to
// the roster when done (the Tutorials tab shows the walk).
export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string; seasonal?: boolean; tutorialDone?: boolean; alias?: string } | null;
  if (!body || typeof body !== "object") return json({ error: "Bad JSON" }, { status: 400 });
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email does not look right" }, { status: 400 });
  if (!password) return json({ error: "Password is required" }, { status: 400 });
  const seasonal = body.seasonal !== false;
  if (body.tutorialDone) {
    const r = await pyrelay.addRosterAccount({ email, password, seasonal, alias: body.alias });
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json({ ok: true, where: "roster", account: r.data.account });
  }
  const r = await accountgen.addAccount({ email, password, seasonal, name: body.alias });
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  if (!r.data.added) return json({ error: "That account is already queued or walked" }, { status: 409 });
  return json({ ok: true, where: "onboarding" });
}
