// What hub users ask this node to do (design doc §6.3): deposits into and
// withdraws from communism by anyone signed in to the hub, met in game by
// a communism account; and the owner's own actions from the hub website —
// offers, and node-to-node communism takes and gives. Requests are queued on
// the hub, pulled here, run against the local queue or the coordinators,
// and answered with progress reports until they close.
import type Database from "better-sqlite3";
import type { GuestRequestResult, GuestRequestWire, OfferWire } from "../shared/hubWire";
import type { CommunismCoordinator } from "./communism";
import type { HubClient } from "./hub";
import type { SwapCoordinator } from "./swaps";
import type { PyrelayPool } from "../lib/devauth";
import { createDepositRequest } from "../lib/depositRequest";
import { MAX_TRADE_SLOTS } from "../lib/depositSizes";
import { countWant, createCommunismWithdraw, describeItems } from "../lib/communismWithdraw";
import { depositGroupStatus } from "../lib/depositStatus";
import { withdrawGroupStatus } from "../lib/withdrawStatus";
import { parseWantInput } from "../lib/offers";
import { blockMessage, depositBlock, withdrawBlock } from "../lib/serverControls";
import { advancedForPool } from "../lib/advanced";

/**
 * The runner asks the hub for requests and lets the hub hold the answer up
 * to REQUEST_WAIT_S until one lands (docs/hub-protocol.md, `?wait=`): a
 * request is picked up the moment it is queued, at the cost of one request
 * per wait while idle. After an error it retries after REQUEST_POLL_MS.
 */
export const REQUEST_WAIT_S = Math.min(25, Math.max(0, Number(process.env.GUEST_WAIT_SECONDS ?? 25)));
export const REQUEST_POLL_MS = Number(process.env.GUEST_POLL_SECONDS ?? 15) * 1000;
/** Progress on an open request is reported this long after the queue moved (several rows move at once when a bot claims). */
const PROGRESS_DEBOUNCE_MS = 500;
const IGN_RE = /^[A-Za-z]{1,32}$/;
/** What only the node's owner asks for: offers and node-to-node communism. They act on the node's own pool and bots, so they run one at a time, in one lane. */
const OWNER_KINDS = new Set<GuestRequestWire["kind"]>(["offer-create", "offer-accept", "offer-cancel", "communism-take", "communism-give"]);
/**
 * Under advanced management for communism (docs/relay/ADVANCED.md) requests
 * run at once, one lane per person: a lane runs its requests in the order the
 * hub handed them out, because one person's requests depend on each other (one
 * open deposit per IGN, a withdraw cap per IGN, bots serving a player's oldest
 * row first), while different people's requests do not. Otherwise every
 * request shares one lane, one at a time, as before.
 */
const laneOf = (req: GuestRequestWire): string => (!advancedForPool(true) ? "all" : OWNER_KINDS.has(req.kind) ? "owner" : `user:${req.requester.userId}`);

export interface RequestsOptions {
  db: () => Database.Database;
  hub: HubClient;
  swaps: SwapCoordinator;
  communism: CommunismCoordinator;
  pool: () => PyrelayPool | null;
  log: (s: string) => void;
  now?: () => number;
  /** Subscribe to the queue's "a request group moved" signal; progress is reported shortly after each. */
  onRequestChanged?: (fn: () => void) => () => void;
}

/** A deposit or withdraw still open on the queue, reported back to the hub as it moves. */
interface Tracked {
  hubId: number;
  kind: "deposit" | "withdraw";
  groupId: string;
  lastDetail: string;
}

export class RequestRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private unhook: (() => void) | null = null;
  private lastRequestsAt: number | null = null;
  private lastError: string | null = null;
  private recent: { id: number; kind: string; requester: string; ok: boolean; detail: string; at: number }[] = [];
  /** Requests being run or waiting in a lane: the hub handing one out again meanwhile (its lease ran out) does not run it twice. */
  private inFlight = new Set<number>();
  /** Per lane (laneOf), the last request queued in it: the next one starts when it ends. */
  private lanes = new Map<string, Promise<void>>();
  /** The progress report under way, and whether another was asked for while it ran. */
  private progressRun: Promise<void> | null = null;
  private progressAgain = false;
  private readonly now: () => number;
  constructor(private readonly o: RequestsOptions) {
    this.now = o.now ?? Date.now;
    o.db().exec(`CREATE TABLE IF NOT EXISTS hub_requests (
      hub_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      group_id TEXT NOT NULL,
      last_detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    -- Every request this node ran, by the hub's id, with the answer it gave: a request handed out again (the hub never
    -- saw the answer) is answered again rather than run twice, and an answer the hub did not get is sent until it does.
    CREATE TABLE IF NOT EXISTS hub_request_results (
      hub_id INTEGER PRIMARY KEY,
      result_json TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
    )`);
  }

  /** One round: take what is queued (waiting up to `waitS` for something to be), run it, report progress on the open ones. Null when the hub could not be asked. */
  async pollRequests(waitS = 0): Promise<number | null> {
    const taken = await this.take(waitS);
    if (taken === null) return null;
    await taken.done;
    await this.progress();
    return taken.n;
  }

  /**
   * Ask the hub for what is queued (waiting up to `waitS` for something to
   * be) and start it, each request in its person's lane. `done` settles once
   * everything started here has run; the loop does not wait for it, so the
   * next request is picked up while these run.
   */
  private async take(waitS: number): Promise<{ n: number; busy: number; done: Promise<void> } | null> {
    if (!this.o.hub.linked) return null;
    const r = await this.o.hub.signed<{ requests: GuestRequestWire[] }>("GET", `/api/v1/guest-requests${waitS > 0 ? `?wait=${waitS}` : ""}`, undefined, { timeoutMs: (waitS + 10) * 1000 });
    this.lastRequestsAt = this.now();
    if (!r.ok) {
      this.lastError = `requests: ${r.error}`;
      return null;
    }
    this.lastError = null;
    await this.flushUndelivered();
    const db = this.o.db();
    const started: Promise<void>[] = [];
    let busy = 0;
    for (const req of r.data.requests) {
      if (this.inFlight.has(req.id)) {
        busy++;
        continue;
      }
      const done = db.prepare("SELECT result_json FROM hub_request_results WHERE hub_id = ?").get(req.id) as { result_json: string } | undefined;
      if (done) {
        // Handed out again: the hub never got our answer. Answer again; nothing runs twice.
        this.o.log(`requests: #${req.id} came again (the hub did not get our answer); answering again`);
        await this.deliver(req.id, JSON.parse(done.result_json) as GuestRequestResult);
        continue;
      }
      this.inFlight.add(req.id);
      started.push(this.enqueue(laneOf(req), () => this.run(req)));
    }
    return { n: started.length, busy, done: Promise.all(started).then(() => undefined) };
  }

  /** Queue `job` behind the last one in `lane`; it never fails, so a lane never stops. */
  private enqueue(lane: string, job: () => Promise<void>): Promise<void> {
    const next = (this.lanes.get(lane) ?? Promise.resolve()).then(job).catch((e) => this.o.log(`requests: lane ${lane} failed: ${String(e)}`));
    this.lanes.set(lane, next);
    void next.then(() => {
      if (this.lanes.get(lane) === next) this.lanes.delete(lane);
    });
    return next;
  }

  /** Run one request and answer it: the answer is kept until the hub has it. */
  private async run(req: GuestRequestWire): Promise<void> {
    const db = this.o.db();
    try {
      const result = await this.execute(req).catch((e): GuestRequestResult => ({ ok: false, error: String((e as Error).message ?? e) }));
      db.prepare("INSERT INTO hub_request_results (hub_id, result_json, delivered, at) VALUES (?, ?, 0, ?) ON CONFLICT(hub_id) DO NOTHING").run(req.id, JSON.stringify(result), this.now());
      await this.deliver(req.id, result);
      this.remember(req, result);
      this.o.log(`requests: ${req.requester.displayName} ${req.kind} #${req.id} -> ${result.ok ? (result.pending ? "queued" : "ok") : `failed: ${result.error}`}`);
    } finally {
      this.inFlight.delete(req.id);
      // Running in lanes, nothing waits for the round to end: progress follows each request.
      if (advancedForPool(true)) this.scheduleProgress();
    }
  }

  /** The first answer to a request, kept until the hub has it. */
  private async deliver(hubId: number, result: GuestRequestResult): Promise<void> {
    if (await this.report(hubId, result)) this.o.db().prepare("UPDATE hub_request_results SET delivered = 1 WHERE hub_id = ?").run(hubId);
  }
  /** First answers the hub did not get (it was down): sent again each round. A day on, the hub has expired the request anyway. */
  private async flushUndelivered(): Promise<void> {
    const db = this.o.db();
    db.prepare("DELETE FROM hub_request_results WHERE at < ?").run(this.now() - 24 * 3_600_000);
    const rows = db.prepare("SELECT hub_id, result_json FROM hub_request_results WHERE delivered = 0").all() as { hub_id: number; result_json: string }[];
    for (const r of rows) await this.deliver(r.hub_id, JSON.parse(r.result_json) as GuestRequestResult);
  }

  /**
   * Tell the hub. True once it has the word, or refused it for good (a 4xx: the request is closed or gone there, and
   * sending again would change nothing); false when it could not be reached, and the caller tries again.
   */
  private async report(hubId: number, result: GuestRequestResult): Promise<boolean> {
    const rr = await this.o.hub.signed("POST", `/api/v1/guest-requests/${hubId}/result`, result);
    if (rr.ok) return true;
    const final = rr.status >= 400 && rr.status < 500;
    this.o.log(`requests: result for request #${hubId} ${final ? "refused" : "not delivered (sent again later)"}: ${rr.error}`);
    return final;
  }
  private remember(req: GuestRequestWire, result: GuestRequestResult): void {
    this.recent.unshift({ id: req.id, kind: req.kind, requester: req.requester.displayName, ok: result.ok, detail: result.error ?? result.detail ?? "", at: this.now() });
    if (this.recent.length > 30) this.recent.length = 30;
  }

  /**
   * The open deposits and withdraws this node queued for hub users: tell the
   * hub when a bot has claimed one and when it is done. One report runs at a
   * time; one asked for meanwhile runs once more after it, so no move is missed.
   */
  progress(): Promise<void> {
    if (this.progressRun) {
      this.progressAgain = true;
      return this.progressRun;
    }
    const run = (async () => {
      do {
        this.progressAgain = false;
        await this.reportProgress();
      } while (this.progressAgain);
    })().finally(() => {
      this.progressRun = null;
    });
    this.progressRun = run;
    return run;
  }
  private async reportProgress(): Promise<void> {
    const db = this.o.db();
    const rows = db.prepare("SELECT hub_id, kind, group_id, last_detail FROM hub_requests").all() as { hub_id: number; kind: "deposit" | "withdraw"; group_id: string; last_detail: string }[];
    for (const t of rows) {
      const st = t.kind === "deposit" ? await depositGroupStatus(db, t.group_id) : await withdrawGroupStatus(db, t.group_id);
      if (!st) {
        db.prepare("DELETE FROM hub_requests WHERE hub_id = ?").run(t.hub_id);
        continue;
      }
      // The bot to /trade is the one on the trade under way (a claimed row), else the next one waiting: a request of
      // several trades (several accounts, a deposit continuing on another bot) names each in turn, never one that is done.
      const at = st.trades.findIndex((x) => x.status === "claimed");
      const nextAt = at >= 0 ? at : st.trades.findIndex((x) => x.status === "pending");
      const bot = nextAt >= 0 ? st.trades[nextAt].botIgn ?? undefined : undefined;
      const traded = [...new Set(st.trades.filter((x) => x.status === "fulfilled").map((x) => x.botIgn).filter((x): x is string => !!x))];
      const last = traded[traded.length - 1];
      const turn = st.trades.length > 1 && nextAt >= 0 ? ` (trade ${nextAt + 1} of ${st.trades.length})` : "";
      let result: GuestRequestResult;
      if (st.groupStatus === "fulfilled") result = { ok: true, detail: traded.length ? `done: traded with ${traded.join(", ")}` : "done", ...(last ? { botIgn: last } : {}) };
      else if (st.groupStatus === "partial") result = { ok: true, detail: `partly done${traded.length ? ` (traded with ${traded.join(", ")})` : ""}`, ...(last ? { botIgn: last } : {}) };
      else if (st.groupStatus === "cancelled") result = { ok: false, error: t.kind === "deposit" ? (("endReason" in st && st.endReason) ? `ended: ${st.endReason}` : "cancelled or timed out before the trade") : "cancelled or timed out before the trade" };
      else result = { ok: true, pending: true, detail: bot ? `${bot} is on the way${turn} — /trade ${bot} when it arrives` : `queued${turn}; waiting for a communism account to come`, ...(bot ? { botIgn: bot } : {}) };
      const detail = `${result.ok}|${result.pending ?? false}|${result.detail ?? result.error ?? ""}`;
      if (detail === t.last_detail) continue;
      // Not delivered: nothing is marked, so the next round reports it again (the final word above all: the row stays until the hub has it).
      if (!(await this.report(t.hub_id, result))) continue;
      // The hub keeps the latest word: a first answer it never got is not sent after this one (it would put back an older note).
      db.prepare("UPDATE hub_request_results SET delivered = 1 WHERE hub_id = ? AND delivered = 0").run(t.hub_id);
      if (result.pending) db.prepare("UPDATE hub_requests SET last_detail = ? WHERE hub_id = ?").run(detail, t.hub_id);
      else db.prepare("DELETE FROM hub_requests WHERE hub_id = ?").run(t.hub_id);
    }
  }

  private track(hubId: number, kind: "deposit" | "withdraw", groupId: string, detail: string): void {
    this.o.db().prepare("INSERT INTO hub_requests (hub_id, kind, group_id, last_detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hub_id) DO UPDATE SET kind = excluded.kind, group_id = excluded.group_id, last_detail = excluded.last_detail")
      .run(hubId, kind, groupId, `true|true|${detail}`, this.now());
  }

  /** One request, against the local queue or a coordinator. */
  async execute(req: GuestRequestWire): Promise<GuestRequestResult> {
    const db = this.o.db();
    switch (req.kind) {
      case "deposit": {
        if (!req.server || !req.count) return { ok: false, error: "a deposit needs a server and a count" };
        if (!IGN_RE.test(req.ign)) return { ok: false, error: "set your in-game name on the hub first" };
        // The node's server switches and Realm's load, as for a deposit made on the node's own site.
        const block = depositBlock(db, req.server);
        if (block) return { ok: false, error: blockMessage(req.server, "deposit", block) };
        const room = this.o.communism.room(req.seasonal);
        if (room.accounts === 0) return { ok: false, error: `this node has no ${req.seasonal ? "seasonal" : "non-seasonal"} communism account` };
        if (room.free < 1) return { ok: false, error: `the ${req.seasonal ? "seasonal" : "non-seasonal"} communism on this node is full right now` };
        // One trade of as many items as they bring: a communism account with that much room meets them.
        const slots = Math.min(req.count, MAX_TRADE_SLOTS);
        const r = await createDepositRequest(db, { ign: req.ign, ignLower: req.ign.toLowerCase(), server: req.server, slots, seasonal: req.seasonal ? 1 : 0, communism: true });
        if (!r.ok) return { ok: false, error: r.error };
        const detail = `deposit queued on ${req.server}; a communism account is coming — /trade it when it arrives`;
        this.track(req.id, "deposit", r.groupId, detail);
        return { ok: true, pending: true, requestId: r.requestId, detail };
      }
      case "withdraw": {
        // "N of this item" (docs/relay/ADVANCED.md): no refs, want lines; the node picks the copies.
        const byCount = !req.refs?.length && req.want?.length ? countWant(req.want) : null;
        if (!req.server || (!req.refs?.length && !byCount)) return { ok: false, error: "a withdraw needs a server and items" };
        if (typeof byCount === "string") return { ok: false, error: byCount };
        if (!IGN_RE.test(req.ign)) return { ok: false, error: "set your in-game name on the hub first" };
        const block = withdrawBlock(db, req.server);
        if (block) return { ok: false, error: blockMessage(req.server, "withdraw", block) };
        const pool = this.o.pool();
        if (!pool) return { ok: false, error: "the fleet is not reachable" };
        const r = createCommunismWithdraw(db, pool, { ign: req.ign, server: req.server, seasonal: req.seasonal, ...(byCount ? { want: byCount, exclude: req.held ?? [] } : { instanceIds: req.refs ?? [] }) });
        if (!r.ok) return { ok: false, error: r.error };
        // The copies the node picked leave the board now rather than at the next publish tick: the hub counts what is left by it.
        if (byCount) this.o.communism.schedulePublish();
        let what: string;
        if (byCount) what = describeItems(byCount.flatMap((w) => Array.from({ length: w.qty }, () => w.itemId)));
        else {
          const itemOf = new Map(this.o.communism.items().map((i) => [i.instanceId, i.itemId]));
          what = describeItems((req.refs ?? []).map((id) => itemOf.get(id) ?? id));
        }
        const trades = r.requestIds.length > 1 ? ` in ${r.requestIds.length} trades` : "";
        const detail = `withdraw of ${what} queued on ${req.server}${trades}${r.fetched ? " (fetched from storage first)" : ""}; the account holding it is coming`;
        this.track(req.id, "withdraw", r.groupId, detail);
        return { ok: true, pending: true, requestId: r.requestIds[0], detail };
      }
      case "offer-create": {
        if (!req.owner) return { ok: false, error: "only the node's owner posts offers with it" };
        if (!req.refs?.length || !req.want?.length || !req.server) return { ok: false, error: "an offer needs items, wants and a server" };
        const want = parseWantInput(req.want);
        if (!want.ok) return { ok: false, error: want.error };
        const r = await this.o.swaps.createOffer({ instanceIds: req.refs, want: want.want, server: req.server });
        return r.ok ? { ok: true, offerId: r.offer.id, detail: `offer #${r.offer.id} posted from ${r.offer.botIgn}` } : { ok: false, error: r.error };
      }
      case "offer-accept": {
        if (!req.owner) return { ok: false, error: "only the node's owner accepts offers with it" };
        if (!req.offerId) return { ok: false, error: "which offer?" };
        const b = await this.o.swaps.browse();
        if (!b.ok) return { ok: false, error: b.error };
        const offer = b.offers.find((o) => o.id === req.offerId);
        if (!offer) return { ok: false, error: "that offer is no longer open" };
        const r = await this.o.swaps.acceptOffer(offer as OfferWire);
        return r.ok ? { ok: true, offerId: offer.id, detail: `meeting #${r.rendezvous.id} on ${r.rendezvous.server}: ${r.rendezvous.me.botIgn} meets ${r.rendezvous.partner.botIgn}` } : { ok: false, error: r.error };
      }
      case "offer-cancel": {
        if (!req.owner) return { ok: false, error: "only the node's owner cancels its offers" };
        if (!req.offerId) return { ok: false, error: "which offer?" };
        const r = await this.o.swaps.cancelOffer(req.offerId);
        return r.ok ? { ok: true, offerId: req.offerId } : { ok: false, error: r.error };
      }
      case "communism-take": {
        if (!req.owner) return { ok: false, error: "only the node's owner takes communism items with it" };
        if (!req.communism?.ref || !req.server) return { ok: false, error: "a communism take needs the listed item and a server" };
        const listed = await this.o.communism.browse();
        if (!listed.ok) return { ok: false, error: listed.error };
        const item = listed.items.find((it) => it.nodeId === req.communism!.nodeId && it.ref === req.communism!.ref);
        if (!item) return { ok: false, error: "that item is no longer listed" };
        const r = await this.o.communism.withdraw({ nodeId: item.nodeId, ref: item.ref, itemId: item.itemId, seasonal: item.seasonal, server: req.server });
        return r.ok ? { ok: true, detail: `meeting #${r.rendezvous.id} on ${r.rendezvous.server}: ${r.botIgn} receives ${item.name}` } : { ok: false, error: r.error };
      }
      case "communism-give": {
        if (!req.owner) return { ok: false, error: "only the node's owner gives its items away" };
        if (!req.communism?.nodeId || !req.refs?.length || !req.server) return { ok: false, error: "a hand-over needs a communism to give to, items and a server" };
        const r = await this.o.communism.give({ nodeId: req.communism.nodeId, instanceIds: req.refs, server: req.server });
        return r.ok ? { ok: true, detail: `meeting #${r.rendezvous.id} on ${r.rendezvous.server}: ${r.botIgn} hands ${req.refs.length} item(s) to ${r.rendezvous.partner.botIgn}` } : { ok: false, error: r.error };
      }
      default:
        return { ok: false, error: `unknown request kind ${String((req as { kind: string }).kind)}` };
    }
  }

  // --- lifecycle ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unhook = this.o.onRequestChanged?.(() => this.scheduleProgress()) ?? null;
    void this.loop();
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    this.unhook?.();
    this.unhook = null;
  }
  /**
   * Ask, wait, ask again: the hub answers at once when a request lands, else
   * after the wait. Under advanced management for communism what it hands out
   * runs in its lanes while the next ask is already waiting; otherwise the next
   * ask comes once it has all run. An error (or no link) backs off.
   */
  private async loop(): Promise<void> {
    while (this.running) {
      if (!advancedForPool(true)) {
        // One request at a time, the next ask after them, as before advanced management.
        const n = await this.pollRequests(REQUEST_WAIT_S).catch(() => null);
        if (!this.running) return;
        if (n === null || REQUEST_WAIT_S === 0) await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, REQUEST_POLL_MS);
          this.timer.unref?.();
        });
        continue;
      }
      const taken = await this.take(REQUEST_WAIT_S).catch(() => null);
      if (!this.running) return;
      if (taken) void this.progress().catch((e) => this.o.log(`requests: progress report failed: ${String(e)}`));
      // Only requests still running here, handed out again because their lease ran out while they waited in a lane: the
      // hub answers every ask with them at once until they are answered, so wait rather than ask in a tight loop.
      const onlyBusy = !!taken && taken.n === 0 && taken.busy > 0;
      if (taken === null || onlyBusy || REQUEST_WAIT_S === 0) await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, REQUEST_POLL_MS);
        this.timer.unref?.();
      });
    }
  }
  private scheduleProgress(): void {
    if (this.progressTimer || !this.running) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      void this.progress().catch((e) => this.o.log(`requests: progress report failed: ${String(e)}`));
    }, PROGRESS_DEBOUNCE_MS);
    this.progressTimer.unref?.();
  }
  status() {
    return { linked: this.o.hub.linked, lastRequestsAt: this.lastRequestsAt, lastError: this.lastError, recent: this.recent, running: this.inFlight.size };
  }
}
