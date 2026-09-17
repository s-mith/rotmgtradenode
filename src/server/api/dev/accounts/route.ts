import { json } from "@/server/http";
import { accountgen, checkDevPassword, pyrelay } from "@/lib/devauth";

// POST /api/dev/accounts — the owner adds one of their own accounts.
//
// { email, password, seasonal, tutorialDone, alias? }
// or { action: "retry-suspended", guids? } — re-check suspended accounts
// against Realm over HTTP and un-retire the ones it accepts.
//
// tutorialDone=true: the account has a character past the tutorial, so it
// goes straight onto the roster and the fleet may log it in. Otherwise it
// goes to the onboarding service, which walks the tutorial and hands it to
// the roster when done (the Tutorials tab shows the walk).
export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { action?: string; guids?: string[]; guid?: string; charId?: unknown; email?: string; password?: string; seasonal?: boolean; tutorialDone?: boolean; alias?: string } | null;
  if (!body || typeof body !== "object") return json({ error: "Bad JSON" }, { status: 400 });
  if (body.action === "set-char") {
    const charId = body.charId === null || body.charId === undefined || body.charId === "" ? null : Number(body.charId);
    const r = await pyrelay.setPreferredChar(String(body.guid ?? ""), charId);
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  if (body.action === "retry-suspended") {
    const r = await pyrelay.retrySuspended(Array.isArray(body.guids) ? body.guids.map(String) : undefined);
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  if (body.action === "set-credentials") {
    const r = await pyrelay.setAccountCredentials(String(body.guid ?? ""), { email: body.email === undefined ? undefined : String(body.email), password: body.password === undefined ? undefined : String(body.password) });
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  if (body.action === "sweep") {
    const r = await pyrelay.sweepAccounts(Array.isArray(body.guids) ? body.guids.map(String) : []);
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  // As typed: Realm's login address is case-sensitive.
  const email = String(body.email ?? "").trim();
  const password = String(body.password ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email does not look right" }, { status: 400 });
  if (!password) return json({ error: "Password is required" }, { status: 400 });
  // The fleet asks Realm: tutorial done and a character to load -> the roster
  // (season from that character); otherwise the account is queued for its
  // tutorial here, on the chosen pool when it has no character yet.
  const seasonal = body.seasonal !== false;
  const r = await pyrelay.addRosterAccount({ email, password, seasonal, alias: body.alias });
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  if (r.data.where === "roster") return json({ ok: true, where: "roster", account: r.data.account, detected: r.data.detected });
  const q = await accountgen.addAccount({ email, password, seasonal: r.data.seasonal, name: body.alias });
  if (!q.ok) return json({ error: q.error }, { status: q.status });
  if (!q.data.added) return json({ error: "That account is already queued or walked" }, { status: 409 });
  return json({ ok: true, where: "onboarding", detected: r.data.detected });
}
