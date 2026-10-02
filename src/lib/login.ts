// Player login by copy-pasted /tell.
//
// The vault used to trust an IGN typed into a form. Login replaces that with a
// proof of control that costs the player one paste:
//
//   1. startLogin()  — mint a random code, register it with pyrelay
//      (POST /login/register-code), and hand the browser the code plus a bot
//      IGN to show as `/tell <bot> <code>`.
//   2. the player pastes that line in game. The tell arriving at the bot from
//      their character is the proof — you can only /tell as a character you're
//      logged into — and pyrelay's LoginCodePlugin binds the code to the sender.
//   3. pollLogin() — the browser polls until pyrelay reports "verified" with
//      the sender's IGN; the caller then issues the session cookie for it.
//
// No site-side challenge store: pyrelay holds the short-lived code→sender map
// and verified is single-use there, so the site just relays start/poll.
import crypto from "node:crypto";
import { pyrelay } from "./devauth";

// 10 alphanumeric chars (~59 bits). Wide enough that polling code-state can't
// be brute-forced to harvest which IGN paired with a code, and it's still short
// enough to paste. Uppercase + digits only — no lowercase, to dodge Realm chat
// case-folding surprises and lookalike ambiguity.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 10;

function mintCode(): string {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export type StartResult =
  | { ok: true; code: string; botIgn: string }
  | { ok: false; status: number; error: string };

export type PollResult =
  | { ok: true; state: "verified"; ign: string }
  | { ok: true; state: "pending" | "expired" }
  | { ok: false; status: number; error: string };

// The login desk is staffed on demand unless the owner keeps it on (Overview):
// with nobody at it, the fleet logs a bot in on the first 503 and each retry
// checks whether it has arrived, so the code goes out once a bot is in the game
// to receive the tell. A login (and a queue) can take a minute or two; bounded
// so a genuinely dead fleet still errors instead of hanging forever.
const START_MAX_WAIT_MS = Number(process.env.LOGIN_START_WAIT_SECONDS ?? 150) * 1000;
const START_POLL_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mint + register a login code and return the `/tell` target.
 *
 * Blocks until a bot is in-world to field the login (or the wait cap is hit) —
 * `registerLoginCode` returns 503 while the fleet is still waking one, so we
 * retry the same code until it takes. In steady state a bot is already up and
 * this returns on the first try.
 */
export async function startLogin(): Promise<StartResult> {
  const code = mintCode();
  const deadline = Date.now() + START_MAX_WAIT_MS;
  for (;;) {
    const reg = await pyrelay.registerLoginCode(code);
    if (reg.ok) {
      return { ok: true, code, botIgn: reg.data.botIgn ?? "" };
    }
    // Anything other than "no bot online yet" is a real failure — bail now.
    if (reg.status !== 503) {
      return { ok: false, status: 502, error: "Couldn't reach the bot service — try again in a minute." };
    }
    if (Date.now() >= deadline) {
      return { ok: false, status: 503, error: "Couldn't get a bot online in time — try again in a minute." };
    }
    await sleep(START_POLL_MS);
  }
}

/** Poll pyrelay for whether the pasted tell has landed. */
export async function pollLogin(code: string): Promise<PollResult> {
  const res = await pyrelay.loginCodeState(code);
  if (!res.ok) {
    return { ok: false, status: 502, error: "Couldn't reach the bot service — try again." };
  }
  if (res.data.state === "verified" && res.data.ign) {
    return { ok: true, state: "verified", ign: res.data.ign };
  }
  return { ok: true, state: res.data.state === "verified" ? "pending" : res.data.state };
}
