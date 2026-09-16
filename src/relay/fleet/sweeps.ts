// Startup sweep (snapshot bots whose persisted inventory can't be trusted)
// and the operator's fleet-wide ban sweep. Both run the same per-account
// routine: log in, wait for the character to settle, snapshot, log out.
import type { GameClient } from "../client/gameClient";
import { toCatalogId } from "../trade/itemMap";
import type { BotAccount, BotPool } from "./botPool";
import { bringUp, BringUpRefused, takeDown, type BringUpVerdict, type FleetDeps } from "./bringUp";
import type { InventoryTracker } from "./inventoryTracker";
import type { PoolSettings, TradeHold } from "./stores";
import type { WakeScheduler } from "./wakes";

const PER_BOT_TIMEOUT_MS = 25_000;
const MIN_SETTLE_MS = 4_000;
const STABLE_FOR_MS = 1_500;
const POLL_MS = 500;
const MAX_CONCURRENT_SWEEPS = 25;
const SWEEP_STAGGER_MS = 200;
const RETRY_PAUSE_MS = 10_000;
const SWEEP_ONLINE_WINDOW_S = Number(process.env.SWEEP_ONLINE_WINDOW_S ?? 180);

export interface SweepDeps {
  deps: FleetDeps;
  pool: BotPool;
  tracker: InventoryTracker;
  settings: PoolSettings;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function snapshotKey(client: GameClient, hasBp: boolean): string {
  const inv = client.playerData.inv;
  return JSON.stringify([hasBp, inv.slice(4, 12), inv.slice(12, 20), client.playerData.enchantments]);
}

export function snapshotInventory(client: GameClient): { slots: Record<number, { itemId: string; enchantments: number[] }>; capacity: number; hasBp: boolean } {
  const hasBp = client.hasBackpack;
  const end = hasBp ? 20 : 12;
  const slots: Record<number, { itemId: string; enchantments: number[] }> = {};
  const inv = client.playerData.inv;
  for (let i = 4; i < end && i < inv.length; i++) {
    if (inv[i] === -1) continue;
    const cid = toCatalogId(inv[i]);
    if (cid === undefined) continue;
    slots[i] = { itemId: cid, enchantments: [...(client.playerData.enchantments[i] ?? [])] };
  }
  return { slots, capacity: hasBp ? 16 : 8, hasBp };
}

/** Log in, wait for in-world, snapshot, log out. */
export async function sweepOne(sd: SweepDeps, acc: BotAccount, label: string): Promise<BringUpVerdict> {
  const { deps, tracker } = sd;
  const locked = deps.gate.lockoutRemainingMs(acc.guid);
  if (locked > 0) {
    deps.log(`sweep: skipping ${label} — login-locked for ${Math.floor(locked / 1000)}s more`);
    return "locked";
  }
  deps.log(`sweep: waking ${label} for inventory snapshot`);
  let client: GameClient;
  try {
    client = await (deps.bringUp ?? bringUp)(deps, acc, acc.info.server ?? "USSouth3");
  } catch (e) {
    const verdict = e instanceof BringUpRefused ? e.verdict : "failed";
    deps.log(`sweep: bring-up refused for ${label} (${verdict})`);
    return verdict;
  }
  if (client.charSeasonal !== null) sd.pool.setSeasonal(acc, client.charSeasonal);
  const deadline = Date.now() + PER_BOT_TIMEOUT_MS;
  let inWorldAt: number | null = null;
  let lastKey: string | null = null;
  let stableSince: number | null = null;
  const finish = (why: string): BringUpVerdict => {
    const { slots, capacity, hasBp } = snapshotInventory(client);
    tracker.updateFromSlots(acc.botGuid, slots, capacity);
    if (client.playerData.name) tracker.recordIgn(acc.botGuid, client.playerData.name);
    deps.log(`sweep: ${label} ${why} ${Object.keys(slots).length} item(s), cap ${capacity} (${hasBp ? "backpack" : "no backpack"})`);
    takeDown(deps, acc, "sweep done");
    return "captured";
  };
  while (Date.now() < deadline) {
    if (!client.active) {
      deps.log(`sweep: ${label} client went inactive mid-sweep`);
      takeDown(deps, acc, "sweep client died");
      return acc.suspended ? "suspended" : deps.gate.lockoutRemainingMs(acc.guid) > 0 ? "locked" : "failed";
    }
    if (client.objectId !== -1 && client.playerData.name) {
      const now = Date.now();
      inWorldAt ??= now;
      const key = snapshotKey(client, client.hasBackpack);
      if (key !== lastKey) {
        lastKey = key;
        stableSince = now;
      }
      if (now - inWorldAt >= MIN_SETTLE_MS && stableSince !== null && now - stableSince >= STABLE_FOR_MS) return finish("captured");
    }
    await sleep(POLL_MS);
  }
  if (inWorldAt !== null) return finish("timed out but captured");
  deps.log(`sweep: ${label} timed out before reaching in-world`);
  takeDown(deps, acc, "sweep timeout");
  return "failed";
}

/** sweepOne with one retry on an inconclusive result. */
export async function sweepAccount(sd: SweepDeps, acc: BotAccount, label: string): Promise<BringUpVerdict> {
  let v = await sweepOne(sd, acc, label);
  if (v !== "failed") return v;
  // The teardown stamps the reconnect grace on the account (Realm holds the
  // session for a few seconds), so the retry waits that out rather than
  // being refused by it — a restart right after a shutdown hits this for
  // every bot that was online.
  const wait = Math.max(RETRY_PAUSE_MS, sd.deps.gate.lockoutRemainingMs(acc.guid) + 1000);
  sd.deps.log(`sweep: retrying ${label} in ${Math.round(wait / 1000)}s`);
  await sleep(wait);
  v = await sweepOne(sd, acc, `${label} retry`);
  if (v !== "captured") sd.deps.log(`sweep: giving up on ${label} -> ${v} (last-known inventory retained)`);
  return v;
}

function sweepReason(botGuid: string, prev: InventoryTracker["previous"]): string | null {
  if (process.env.SWEEP_ALL === "1") return "SWEEP_ALL=1";
  if (!prev.known.has(botGuid)) return "no persisted snapshot";
  const v = prev.verified.get(botGuid);
  if (v === undefined) return "no verified stamp";
  if (prev.savedAt === null) return "state file has no saved_at";
  if (prev.savedAt - v <= SWEEP_ONLINE_WINDOW_S) return "online at last shutdown";
  return null;
}

/** Blocking boot sweep over the accounts whose snapshot can't be trusted. */
export async function startupSweep(sd: SweepDeps): Promise<void> {
  const all = sd.pool.all();
  if (!all.length) {
    sd.deps.log("startup_sweep: pool is empty, skipping");
    return;
  }
  const todo: BotAccount[] = [];
  let skipped = 0;
  for (const acc of all) {
    const reason = sweepReason(acc.botGuid, sd.tracker.previous);
    if (!reason) {
      skipped++;
      continue;
    }
    sd.deps.log(`startup_sweep: ${acc.alias} needs sweep — ${reason}`);
    todo.push(acc);
  }
  if (skipped) sd.deps.log(`startup_sweep: skipping ${skipped} bot(s) with trusted snapshots`);
  if (!todo.length) {
    sd.deps.log("startup_sweep: nothing stale — no sweep needed");
    return;
  }
  sd.deps.log(`startup_sweep: sweeping ${todo.length} of ${all.length} bot(s) (<= ${MAX_CONCURRENT_SWEEPS} concurrent)`);
  let running = 0;
  const waiters: (() => void)[] = [];
  const tasks: Promise<unknown>[] = [];
  for (const [i, acc] of todo.entries()) {
    while (running >= MAX_CONCURRENT_SWEEPS) await new Promise<void>((r) => waiters.push(r));
    running++;
    tasks.push(
      sweepAccount(sd, acc, `${acc.alias} (${i + 1}/${todo.length})`).finally(() => {
        running--;
        waiters.shift()?.();
      }),
    );
    if (i < todo.length - 1) await sleep(SWEEP_STAGGER_MS);
  }
  await Promise.all(tasks);
  sd.deps.log("startup_sweep: done");
}

// --- ban sweep ---------------------------------------------------------------------

export interface BanSweepState {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  total: number;
  checked: number;
  healthy: number;
  unknown: number;
  skippedOnline: number;
  skippedLocked: number;
  skippedArchived: number;
  banned: { alias: string; guid: string; botGuid: string }[];
  stoppedReason: string | null;
  current: string | null;
  phase: "draining" | "sweeping" | null;
  tradesHeld: boolean;
  concurrency: number;
}

const BAN_CONCURRENCY = Number(process.env.BAN_SWEEP_CONCURRENCY ?? 6);
const BAN_STAGGER_MS = Number(process.env.BAN_SWEEP_STAGGER_SECONDS ?? 1.5) * 1000;
const MAX_PAUSE_WAIT_MS = Number(process.env.BAN_SWEEP_MAX_PAUSE_WAIT_SECONDS ?? 360) * 1000;
const MAX_PAUSE_WAITS = 2;
const DRAIN_TIMEOUT_MS = Number(process.env.BAN_SWEEP_DRAIN_SECONDS ?? 180) * 1000;
const HOLD_REASON = "ban sweep";

export class BanSweep {
  private state: BanSweepState = {
    running: false, startedAt: null, finishedAt: null, total: 0, checked: 0, healthy: 0, unknown: 0,
    skippedOnline: 0, skippedLocked: 0, skippedArchived: 0, banned: [], stoppedReason: null, current: null,
    phase: null, tradesHeld: false, concurrency: 0,
  };
  private cancelled = false;
  private inFlight: string[] = [];

  constructor(private readonly sd: SweepDeps, private readonly hold: TradeHold, private readonly wakes: WakeScheduler) {}

  status(): BanSweepState {
    return { ...this.state, banned: [...this.state.banned] };
  }
  cancel(): boolean {
    if (!this.state.running) return false;
    this.cancelled = true;
    return true;
  }
  start(): BanSweepState {
    if (this.state.running) throw new Error("a ban sweep is already running");
    this.cancelled = false;
    this.inFlight = [];
    this.state = { ...this.state, running: true, startedAt: Date.now() / 1000, finishedAt: null, total: 0, checked: 0, healthy: 0, unknown: 0, skippedOnline: 0, skippedLocked: 0, skippedArchived: 0, banned: [], stoppedReason: null, current: null, phase: "draining", tradesHeld: false, concurrency: 0 };
    void this.run();
    return this.status();
  }

  private isBusy(acc: BotAccount): boolean {
    return acc.inUse || acc.assignedRequestId !== null || this.wakes.waking().has(acc.guid);
  }
  private isConnected(acc: BotAccount): boolean {
    const c = acc.client;
    return !!c && c.active && c.isReady && c.connected;
  }
  private concurrency(): number {
    const want = Math.max(1, BAN_CONCURRENCY);
    const cap = this.sd.deps.proxies.exclusiveCapacity();
    if (cap === null) return want;
    let online = 0;
    for (const c of this.sd.deps.clients.values()) if (c.active) online++;
    return Math.max(1, Math.min(want, cap - online));
  }
  private async drain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    let lastNote = 0;
    while (Date.now() < deadline && !this.cancelled) {
      const busy = this.sd.pool.every().filter((a) => this.isBusy(a));
      if (!busy.length) return;
      if (Date.now() - lastNote >= 15_000) {
        lastNote = Date.now();
        this.sd.deps.log(`BanSweep: waiting for ${busy.length} in-flight trade(s) to finish before sweeping`);
      }
      await sleep(1000);
    }
    if (!this.cancelled) this.sd.deps.log(`BanSweep: trades did not drain within ${DRAIN_TIMEOUT_MS / 1000}s — sweeping anyway`);
  }
  private note(label: string, entering: boolean): void {
    if (entering) this.inFlight.push(label);
    else this.inFlight = this.inFlight.filter((l) => l !== label);
    this.state.current = this.inFlight.length ? this.inFlight.slice(0, 4).join(", ") : null;
  }
  private record(acc: BotAccount, verdict: BringUpVerdict): void {
    if (verdict === "suspended") this.state.banned.push({ alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid });
    else if (verdict === "captured") this.state.healthy++;
    else if (verdict === "locked" || verdict === "paused") this.state.skippedLocked++;
    else this.state.unknown++;
    this.state.checked++;
  }
  private async run(): Promise<void> {
    this.hold.acquire(HOLD_REASON);
    this.state.tradesHeld = true;
    this.sd.deps.log("BanSweep: holding withdraws and deposits — the fleet will finish what it is mid-trade on, then stop claiming");
    try {
      await this.sweep();
    } finally {
      this.hold.release(HOLD_REASON);
      this.state.running = false;
      this.state.finishedAt = Date.now() / 1000;
      this.state.current = null;
      this.state.phase = null;
      this.state.tradesHeld = false;
      this.sd.deps.log(`BanSweep: done — logged in ${this.state.checked}, archived ${this.state.banned.length} banned account(s)${this.state.stoppedReason ? ` (${this.state.stoppedReason})` : ""}`);
    }
  }
  private async sweep(): Promise<void> {
    await this.drain();
    if (this.cancelled) {
      this.state.stoppedReason = "cancelled by operator";
      return;
    }
    const accounts = this.sd.pool.every();
    const concurrency = this.concurrency();
    this.state.total = accounts.length;
    this.state.phase = "sweeping";
    this.state.concurrency = concurrency;
    this.sd.deps.log(`BanSweep: logging in ${accounts.length} account(s) — <= ${concurrency} at once`);
    let running = 0;
    const waiters: (() => void)[] = [];
    const tasks: Promise<void>[] = [];
    let pauseWaits = 0;
    let started = 0;
    for (const acc of accounts) {
      if (this.cancelled) {
        this.state.stoppedReason = "cancelled by operator";
        break;
      }
      if (acc.suspended) {
        this.state.skippedArchived++;
        continue;
      }
      if (this.isConnected(acc) || this.isBusy(acc)) {
        this.state.skippedOnline++;
        continue;
      }
      if (this.sd.deps.gate.lockoutRemainingMs(acc.guid) > 0) {
        this.state.skippedLocked++;
        continue;
      }
      const paused = this.sd.deps.gate.pausedRemainingMs();
      if (paused > 0) {
        pauseWaits++;
        if (pauseWaits > MAX_PAUSE_WAITS || paused > MAX_PAUSE_WAIT_MS) {
          this.state.stoppedReason = "stopped: Realm's login limit kept tripping";
          break;
        }
        this.sd.deps.log(`BanSweep: global login pause is closed for ${Math.floor(paused / 1000)}s — waiting it out (${pauseWaits}/${MAX_PAUSE_WAITS})`);
        await sleep(paused + 1000);
        if (this.cancelled) break;
      }
      started++;
      const label = `${acc.alias} (${started}/${accounts.length})`;
      while (running >= concurrency) await new Promise<void>((r) => waiters.push(r));
      running++;
      this.note(label, true);
      tasks.push(
        sweepAccount(this.sd, acc, label)
          .catch((e) => {
            this.sd.deps.log(`BanSweep: ${label} raised ${String(e)}`);
            return "failed" as const;
          })
          .then((v) => this.record(acc, v))
          .finally(() => {
            this.note(label, false);
            running--;
            waiters.shift()?.();
          }),
      );
      await sleep(BAN_STAGGER_MS);
    }
    await Promise.all(tasks);
  }
}
