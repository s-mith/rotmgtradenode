// The backpack scheduler (docs/relay/BACKPACKS.md §4): one tick a minute that
// keeps every pool and every personal vault at the plan's target by itself.
// At most one maintenance run in flight, started in short batches so a
// restart loses minutes; every tick's decision is written down so the
// console can say why it did or did not act.
//
// Lanes, first with work wins: recycle (off until verified live), chore
// (claim + equip on the plan's picks), the targeted daily login pass, the
// incremental audit, the opt-in month-end backstop.
import fs from "node:fs";
import path from "node:path";
import { dayKey, daysToReset, type BackpackService, type Clocks } from "./backpacks";

export interface SchedulerSettings {
  enabled: boolean;
  choreEverySeconds: number;
  choreBatch: number;
  loginHourUtc: number;
  loginBatch: number;
  auditEverySeconds: number;
  auditBatch: number;
  auditStaleDays: number;
  yieldPending: number;
  minFreeExits: number;
  maxTripsPerHour: number;
  backstop: boolean;
  recycle: boolean;
  /** Fallback headroom fraction until the stock growth is measured. */
  buffer: number;
}
export const DEFAULT_SETTINGS: SchedulerSettings = {
  enabled: true,
  choreEverySeconds: 600,
  choreBatch: 100,
  loginHourUtc: 2,
  loginBatch: 200,
  auditEverySeconds: 3600,
  auditBatch: 500,
  auditStaleDays: 3,
  yieldPending: 5,
  minFreeExits: 15,
  maxTripsPerHour: 600,
  backstop: false,
  recycle: false,
  buffer: 0.2,
};
const NUMERIC: (keyof SchedulerSettings)[] = ["choreEverySeconds", "choreBatch", "loginHourUtc", "loginBatch", "auditEverySeconds", "auditBatch", "auditStaleDays", "yieldPending", "minFreeExits", "maxTripsPerHour", "buffer"];
const BOOLEAN: (keyof SchedulerSettings)[] = ["enabled", "backstop", "recycle"];

/** Merge an operator patch, keeping only known keys with sane values. */
export function applySettingsPatch(base: SchedulerSettings, patch: Record<string, unknown>): SchedulerSettings {
  const out = { ...base };
  for (const k of NUMERIC) {
    const v = patch[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) (out as unknown as Record<string, number>)[k] = v;
  }
  for (const k of BOOLEAN) {
    const v = patch[k];
    if (typeof v === "boolean") (out as unknown as Record<string, boolean>)[k] = v;
  }
  return out;
}

/** Everything a tick's decision depends on, gathered by the scheduler so `decide` stays pure and testable. */
export interface TickInput {
  nowMs: number;
  settings: SchedulerSettings;
  liveChoreAllowed: boolean;
  banSweepHold: boolean;
  runInFlight: string | null;
  loginPausedMs: number;
  pendingPlayers: number;
  /** null when no proxy pool is configured (then exits are not a constraint). */
  freeExits: number | null;
  backoffUntilMs: number;
  tripsLastHour: number;
  clocks: Clocks;
  /** Work available per lane, as account counts. `orders`: pool halves where a waiting 16-slot deposit has no bot and an account could be fitted with a backpack. */
  work: { recycle: number; chore: number; logins: number; audit: number; backstop: number; orders: number };
  lastChoreStartMs: number;
  lastAuditStartMs: number;
  /** The login lane already ran today (UTC). */
  loginsDoneToday: boolean;
  /** The lane the scheduler started last: chore and recycle take turns so neither starves the other. */
  lastLane: LaneName | null;
}
export type LaneName = "recycle" | "chore" | "logins" | "audit" | "backstop";
export interface Decision {
  action: LaneName | "none";
  reason: string;
  /** Batch size for the chosen lane (month-end doubles the chore's). */
  batch: number;
  /** A chore for the orders (one trip per waiting pool half), not the plan's picks. */
  order?: boolean;
}

export function secondsToReset(clocks: Clocks, nowMs: number): number | null {
  return clocks.monthResetsAt === null ? null : clocks.monthResetsAt - nowMs / 1000;
}
export function isMonthEndWindow(clocks: Clocks, nowMs: number): boolean {
  const d = daysToReset(clocks, nowMs);
  return d !== null && d <= 3;
}
export function isBackstopWindow(clocks: Clocks, nowMs: number): boolean {
  const s = secondsToReset(clocks, nowMs);
  return s !== null && s <= 86_400 && s > 0;
}
/** True inside the daily login window: from loginHourUtc for two hours. */
export function inLoginWindow(nowMs: number, loginHourUtc: number): boolean {
  const h = new Date(nowMs).getUTCHours();
  return h >= loginHourUtc && h < loginHourUtc + 2;
}

/** The tick's decision (docs §4.2, §4.3). Pure. */
export function decide(i: TickInput): Decision {
  const s = i.settings;
  const monthEnd = isMonthEndWindow(i.clocks, i.nowMs);
  const choreBatch = monthEnd ? s.choreBatch * 2 : s.choreBatch;
  if (!s.enabled) return { action: "none", reason: "disabled", batch: 0 };
  if (i.banSweepHold) return { action: "none", reason: "ban sweep holding trades", batch: 0 };
  if (i.runInFlight) return { action: "none", reason: `running: ${i.runInFlight}`, batch: 0 };
  if (i.loginPausedMs > 0) return { action: "none", reason: `logins paused by Realm for ${Math.ceil(i.loginPausedMs / 1000)}s`, batch: 0 };
  if (i.backoffUntilMs > i.nowMs) return { action: "none", reason: `backing off after a failure spike, ${Math.ceil((i.backoffUntilMs - i.nowMs) / 60_000)} min left`, batch: 0 };
  // A player is waiting on a 16-slot deposit nothing can serve: fit an empty
  // account with a backpack for them before anything else — this IS one of
  // the pending requests the lane would otherwise yield to.
  if (i.work.orders > 0) {
    if (!i.liveChoreAllowed) return { action: "none", reason: `${i.work.orders} deposit(s) need a backpack bot but the live chore is disabled (BACKPACK_CHORE_LIVE)`, batch: 0 };
    if (i.freeExits !== null && i.freeExits < 1) return { action: "none", reason: "a deposit needs a backpack bot but no exit is free", batch: 0 };
    return { action: "chore", reason: `${i.work.orders} waiting deposit(s) need a backpack bot: fitting one`, batch: i.work.orders, order: true };
  }
  if (i.pendingPlayers > s.yieldPending) return { action: "none", reason: `yielding to ${i.pendingPlayers} pending player request(s)`, batch: 0 };
  if (i.freeExits !== null && i.freeExits < s.minFreeExits) return { action: "none", reason: `only ${i.freeExits} free exit(s), need ${s.minFreeExits}`, batch: 0 };
  const tripsLeft = Math.max(0, s.maxTripsPerHour - i.tripsLastHour);

  const choreDue = i.nowMs - i.lastChoreStartMs >= s.choreEverySeconds * 1000;
  const recycleReady = s.recycle && i.work.recycle > 0;
  const choreReady = i.work.chore > 0 && choreDue;
  // Chore and recycle take turns: a recycle batch after a chore batch and
  // vice versa, so a large seasonal deficit cannot starve the equips.
  const recycleFirst = recycleReady && (!choreReady || i.lastLane === "chore");
  if (recycleFirst) {
    if (tripsLeft === 0) return { action: "none", reason: `trip budget spent (${s.maxTripsPerHour}/h)`, batch: 0 };
    return { action: "recycle", reason: `${i.work.recycle} account(s) to recycle`, batch: Math.min(20, tripsLeft) };
  }
  if (choreReady) {
    if (!i.liveChoreAllowed) return { action: "none", reason: "plan has picks but the live chore is disabled (BACKPACK_CHORE_LIVE)", batch: 0 };
    if (tripsLeft === 0) return { action: "none", reason: `trip budget spent (${s.maxTripsPerHour}/h)`, batch: 0 };
    return { action: "chore", reason: `${i.work.chore} pick(s), claiming and equipping${monthEnd ? " (month end: double batch)" : ""}`, batch: Math.min(choreBatch, tripsLeft) };
  }
  if (recycleReady) {
    if (tripsLeft === 0) return { action: "none", reason: `trip budget spent (${s.maxTripsPerHour}/h)`, batch: 0 };
    return { action: "recycle", reason: `${i.work.recycle} account(s) to recycle`, batch: Math.min(20, tripsLeft) };
  }

  const loginWindow = inLoginWindow(i.nowMs, s.loginHourUtc) && !i.loginsDoneToday;
  if (i.work.logins > 0 && (loginWindow || monthEnd)) {
    if (tripsLeft === 0) return { action: "none", reason: `trip budget spent (${s.maxTripsPerHour}/h)`, batch: 0 };
    return { action: "logins", reason: `${i.work.logins} account(s) short of a login day${monthEnd ? " (month end)" : ""}`, batch: Math.min(s.loginBatch, tripsLeft) };
  }

  const auditDue = i.nowMs - i.lastAuditStartMs >= s.auditEverySeconds * 1000;
  if (i.work.audit > 0 && auditDue) return { action: "audit", reason: `${i.work.audit} account(s) never audited or stale`, batch: s.auditBatch };

  if (s.backstop && isBackstopWindow(i.clocks, i.nowMs) && i.work.backstop > 0) {
    if (tripsLeft === 0) return { action: "none", reason: `trip budget spent (${s.maxTripsPerHour}/h)`, batch: 0 };
    return { action: "backstop", reason: `month ends within 24h: banking ${i.work.backstop} claimable day(s)`, batch: Math.min(s.loginBatch, tripsLeft) };
  }

  const parts: string[] = [];
  if (i.work.chore > 0 && !choreDue) parts.push(`${i.work.chore} pick(s), next chore in ${Math.ceil((s.choreEverySeconds * 1000 - (i.nowMs - i.lastChoreStartMs)) / 1000)}s`);
  else parts.push("no picks");
  if (i.work.logins > 0) parts.push(`${i.work.logins} login target(s) waiting for the ${String(s.loginHourUtc).padStart(2, "0")}:00Z window`);
  if (i.work.audit > 0 && !auditDue) parts.push(`${i.work.audit} to audit later`);
  return { action: "none", reason: parts.join("; "), batch: 0 };
}

export interface SchedulerStatus {
  enabled: boolean;
  settings: SchedulerSettings;
  liveChoreAllowed: boolean;
  lastTickAt: number | null;
  lastDecision: Decision | null;
  lastInput: Omit<TickInput, "settings" | "clocks"> | null;
  backoffUntil: number | null;
  runs: { kind: LaneName; startedAt: number; finishedAt: number | null; total: number; ok: number; failed: number; skipped: number }[];
  counters: Record<string, { claimed: number; equipped: number; logins: number; audited: number; retired: number; recycled: number; runs: number }>;
}

export interface SchedulerDeps {
  service: BackpackService;
  settingsFile: string;
  log: (line: string) => void;
  now?: () => number;
  /** Fleet probes, each cheap. */
  banSweepHold: () => boolean;
  loginPausedMs: () => number;
  pendingPlayers: () => number;
  freeExits: () => number | null;
  liveChoreAllowed: () => boolean;
}

const TICK_MS = 60_000;
const FIRST_TICK_MS = 120_000;
const FAILURE_BREAKER_MIN_DONE = 10;
const FAILURE_BREAKER_RATE = 0.5;
const FAILURE_BACKOFF_MS = 3_600_000;

export class BackpackScheduler {
  private settings: SchedulerSettings;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt: number | null = null;
  private lastDecision: Decision | null = null;
  private lastInput: SchedulerStatus["lastInput"] = null;
  private lastLogged = "";
  private lastLoggedAt = 0;
  private backoffUntil = 0;
  private lastChoreStart = 0;
  private lastAuditStart = 0;
  private lastLoginsDay = "";
  private tripStarts: number[] = [];
  private runs: SchedulerStatus["runs"] = [];
  private current: { kind: LaneName; startedAt: number; via: "audit" | "logins" | "chore" | "recycle" } | null = null;
  private lastLane: LaneName | null = null;
  /** The run in flight is an order's trip (never cancelled for another order). */
  private orderRun = false;
  /** A routine run was already asked to stop for an order; don't ask every tick. */
  private cancelledForOrder = false;
  private counters: SchedulerStatus["counters"] = {};
  private readonly now: () => number;

  constructor(private readonly d: SchedulerDeps) {
    this.now = d.now ?? Date.now;
    this.settings = { ...DEFAULT_SETTINGS };
    try {
      if (fs.existsSync(d.settingsFile)) this.settings = applySettingsPatch(this.settings, JSON.parse(fs.readFileSync(d.settingsFile, "utf8")));
    } catch (e) {
      d.log(`backpacks: settings file ${d.settingsFile} unreadable (${String(e)}) — defaults`);
    }
  }

  start(): void {
    if (this.timer) return;
    this.firstTimer = setTimeout(() => this.tick(), FIRST_TICK_MS);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.d.log(`backpacks: scheduler ${this.settings.enabled ? "enabled" : "present but disabled"} — first tick in ${FIRST_TICK_MS / 1000}s`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  getSettings(): SchedulerSettings {
    return { ...this.settings };
  }
  setSettings(patch: Record<string, unknown>): SchedulerSettings {
    this.settings = applySettingsPatch(this.settings, patch);
    try {
      fs.mkdirSync(path.dirname(this.d.settingsFile), { recursive: true });
      fs.writeFileSync(this.d.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch (e) {
      this.d.log(`backpacks: could not write ${this.d.settingsFile}: ${String(e)}`);
    }
    this.d.log(`backpacks: settings -> ${JSON.stringify(this.settings)}`);
    return this.getSettings();
  }
  status(): SchedulerStatus {
    return {
      enabled: this.settings.enabled, settings: this.getSettings(), liveChoreAllowed: this.d.liveChoreAllowed(),
      lastTickAt: this.lastTickAt, lastDecision: this.lastDecision, lastInput: this.lastInput,
      backoffUntil: this.backoffUntil > this.now() ? this.backoffUntil / 1000 : null,
      runs: this.runs.slice(-20), counters: this.counters,
    };
  }

  /** One tick. Public so the console can force one. */
  tick(): Decision {
    const nowMs = this.now();
    this.lastTickAt = nowMs / 1000;
    this.settleFinishedRun();
    const svc = this.d.service;
    const clocks = svc.clocks();
    const runInFlight = svc.chore.running ? `chore ${svc.chore.done}/${svc.chore.total}` : svc.audit.running ? `audit ${svc.audit.done}/${svc.audit.total}` : svc.logins.running ? `logins ${svc.logins.done}/${svc.logins.total}` : svc.recycle.running ? `recycle ${svc.recycle.done}/${svc.recycle.total}` : null;
    // An order can't wait for a hundred-account batch to finish: stop a
    // routine run at its next account and start the order's trip instead.
    if (runInFlight && !this.orderRun && svc.openOrders(nowMs).length && !this.cancelledForOrder) {
      this.cancelledForOrder = true;
      const stopped = svc.cancelChore() || svc.cancelAudit() || svc.cancelLogins() || svc.cancelRecycle();
      if (stopped) this.d.log(`backpacks: a waiting deposit needs a backpack bot — stopping the ${runInFlight.split(" ")[0]} run to fit one`);
    }
    if (!runInFlight) this.cancelledForOrder = false;
    this.tripStarts = this.tripStarts.filter((t) => nowMs - t < 3_600_000);
    const today = dayKey(nowMs / 1000);
    const work = svc.laneWork(this.settings, nowMs);
    const input: TickInput = {
      nowMs, settings: this.settings, liveChoreAllowed: this.d.liveChoreAllowed(), banSweepHold: this.d.banSweepHold(), runInFlight,
      loginPausedMs: this.d.loginPausedMs(), pendingPlayers: this.d.pendingPlayers(), freeExits: this.d.freeExits(), backoffUntilMs: this.backoffUntil,
      tripsLastHour: this.tripStarts.length, clocks, work, lastChoreStartMs: this.lastChoreStart, lastAuditStartMs: this.lastAuditStart,
      loginsDoneToday: this.lastLoginsDay === today, lastLane: this.lastLane,
    };
    const decision = decide(input);
    this.lastDecision = decision;
    const { settings: _s, clocks: _c, ...rest } = input;
    this.lastInput = rest;
    const line = `${decision.action}: ${decision.reason}`;
    if (line !== this.lastLogged || nowMs - this.lastLoggedAt > 600_000) {
      this.d.log(`backpacks: tick — ${line}`);
      this.lastLogged = line;
      this.lastLoggedAt = nowMs;
    }
    if (decision.action !== "none") this.startLane(decision, nowMs);
    return decision;
  }

  private startLane(decision: Decision, nowMs: number): void {
    const svc = this.d.service;
    let via: "audit" | "logins" | "chore" | "recycle" = "chore";
    try {
      switch (decision.action) {
        case "chore": {
          const guids = decision.order ? svc.orderPicks(nowMs, decision.batch) : svc.chorePicks(this.settings, nowMs, decision.batch);
          if (!guids.length) return;
          svc.startChore({ mode: "live", equip: true, guids });
          this.orderRun = !!decision.order;
          // An order's trip doesn't reset the routine cadence.
          if (!decision.order) this.lastChoreStart = nowMs;
          for (let i = 0; i < guids.length; i++) this.tripStarts.push(nowMs);
          break;
        }
        case "logins": {
          const guids = svc.loginPicks(this.settings, nowMs, decision.batch);
          if (!guids.length) return;
          // Calibrated: an HTTP audit advances the calendar, so the day is bought without a game login (docs §5.3).
          if (svc.verifyCountsAsLogin()) {
            svc.startAudit({ guids });
            via = "audit";
          } else {
            svc.startLogins({ guids });
            via = "logins";
            for (let i = 0; i < guids.length; i++) this.tripStarts.push(nowMs);
          }
          this.lastLoginsDay = dayKey(nowMs / 1000);
          break;
        }
        case "audit": {
          const guids = svc.auditPicks(this.settings, nowMs, decision.batch);
          if (!guids.length) return;
          svc.startAudit({ guids });
          via = "audit";
          this.lastAuditStart = nowMs;
          break;
        }
        case "backstop": {
          const guids = svc.backstopPicks(decision.batch);
          if (!guids.length) return;
          svc.startChore({ mode: "live", equip: false, guids });
          this.lastChoreStart = nowMs;
          for (let i = 0; i < guids.length; i++) this.tripStarts.push(nowMs);
          break;
        }
        case "recycle": {
          const picks = svc.recyclePicks(this.settings, nowMs, decision.batch);
          if (!picks.length) return;
          svc.startRecycle({ picks });
          via = "recycle";
          for (let i = 0; i < picks.length; i++) this.tripStarts.push(nowMs);
          break;
        }
        default:
          return;
      }
      this.current = { kind: decision.action, startedAt: nowMs / 1000, via };
      this.lastLane = decision.action;
      this.d.log(`backpacks: scheduler started ${decision.action} (${decision.reason})`);
    } catch (e) {
      this.d.log(`backpacks: scheduler could not start ${decision.action}: ${String(e)}`);
    }
  }

  /** When the run the scheduler started has finished, record it and apply the failure breaker. */
  private settleFinishedRun(): void {
    if (!this.current) return;
    const svc = this.d.service;
    const run = this.current.via === "audit" ? svc.audit : this.current.via === "logins" ? svc.logins : this.current.via === "recycle" ? svc.recycle : svc.chore;
    if (run.running) return;
    const rec = { kind: this.current.kind, startedAt: this.current.startedAt, finishedAt: run.finishedAt, total: run.total, ok: run.ok, failed: run.failed, skipped: run.skipped };
    this.runs.push(rec);
    if (this.runs.length > 50) this.runs.shift();
    const day = dayKey(this.now() / 1000);
    const c = (this.counters[day] ??= { claimed: 0, equipped: 0, logins: 0, audited: 0, retired: 0, recycled: 0, runs: 0 });
    c.runs++;
    if (this.current.kind === "chore" || this.current.kind === "backstop") {
      c.claimed += svc.chore.claimed;
      c.equipped += svc.chore.equipped;
    } else if (this.current.kind === "logins") c.logins += run.ok;
    else if (this.current.kind === "recycle") c.recycled += run.ok;
    else if (this.current.kind === "audit") {
      c.audited += run.ok;
      c.retired += svc.audit.suspended;
    }
    for (const k of Object.keys(this.counters)) if (Object.keys(this.counters).length > 31 && k < day) delete this.counters[k];
    const done = run.ok + run.failed;
    if ((this.current.kind === "chore" || this.current.kind === "backstop") && done >= FAILURE_BREAKER_MIN_DONE && run.failed / done > FAILURE_BREAKER_RATE) {
      this.backoffUntil = this.now() + FAILURE_BACKOFF_MS;
      this.d.log(`backpacks: ${run.failed} of ${done} trips failed in the last ${this.current.kind} run — something changed; backing off for an hour (last: ${run.lastErrors.slice(-1)[0]?.error ?? "?"})`);
    }
    this.current = null;
  }
}
