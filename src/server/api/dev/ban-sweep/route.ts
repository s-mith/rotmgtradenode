import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// /api/dev/ban-sweep — fleet-wide ban check.
//
//   POST   start a sweep (returns immediately; it runs for minutes)
//   GET    poll its progress
//   DELETE stop one that's running
//
// The work happens in pyrelay (Communism/BanSweep.py), which is the only place
// that holds the credentials, the proxy pool and Realm's login-rate state. This
// route is a thin operator-authenticated proxy.
//
// Starting one PAUSES trading fleet-wide: the sweep logs every account in, so
// pyrelay's dispatcher stops claiming withdraws and deposits and stops waking
// bots until it ends. This site keeps accepting requests throughout — they
// queue and are served when the hold lifts — so there is nothing to gate here.
//
// Nothing is written to this site's DB. An account Realm reports suspended is
// archived on pyrelay's side — flagged in Accounts.json and dropped from
// /pool — so the vault, capacity math and console all correct themselves on
// their next poll. There is no local `suspended` column to keep in step.

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const r = await pyrelay.banSweepStart();
  // 409 is "one is already running" — pass it through with its status so the
  // console can just start polling instead of showing an error.
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, sweep: r.data.sweep });
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const r = await pyrelay.banSweepStatus();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, sweep: r.data.sweep });
}

export async function DELETE(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const r = await pyrelay.banSweepCancel();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  // `stopping` is false when nothing was running — the sweep already finished
  // between the operator reading the page and clicking.
  return json({ ok: true, stopping: r.data.stopping, sweep: r.data.sweep });
}
