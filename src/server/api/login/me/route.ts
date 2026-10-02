import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { sessionUser } from "@/lib/users";

// GET /api/login/me -> { ign: string | null, igns: [...] }
// The current session's verified IGN (the character it acts as), or null when
// not logged in, plus every character linked to the same account. The vault
// reads this on load to decide whether to show the login form or the
// logged-in state, and to source the IGN for deposit/withdraw.
export async function GET(req: Request) {
  const me = sessionUser(getDb(), req);
  if (!me) return json({ ign: null, igns: [] });
  return json({ ign: me.ign, igns: me.igns.map((i) => ({ ign: i.ign, linkedAt: i.linkedAt })) });
}
