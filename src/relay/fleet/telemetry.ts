// Opt-in ban telemetry (design doc §8). Off by default. When the owner turns
// it on, the node reports each suspension it sees to the hub, with enough
// context to split a wave by activity lane and cohort and nothing that
// identifies the account: a salted hash stands in for the email, and the
// salt never leaves this machine.
//
// Nothing is sent without a hub URL. Reports queue in memory and go out in
// one POST per flush; a failed flush keeps them for the next one.
import { createHash } from "node:crypto";
import type { NodeSettingsStore } from "../../node/settings";
import type { BotPool } from "./botPool";
import type { GameVersion } from "../realm/gameVersion";
import type { InventoryTracker } from "./inventoryTracker";

export const TELEMETRY_FLUSH_MS = Number(process.env.TELEMETRY_FLUSH_SECONDS ?? 60) * 1000;
const MAX_QUEUE = 500;

export type Lane = "idle" | "owner-trade" | "swap" | "commons" | "tutorial-walk" | "unknown";

export interface BanReport {
  /** sha256(salt + email), base64url. */
  account: string;
  suspendedAt: number;
  lastSeenAt: number | null;
  /** What the account was doing when last seen. */
  lastLane: Lane;
  heldItems: number;
  seasonal: boolean | null;
  nodeVersion: string;
  build: string;
}

export interface TelemetryStatus {
  enabled: boolean;
  hubUrl: string;
  queued: number;
  sent: number;
  lastFlushAt: number | null;
  lastError: string | null;
}

export interface TelemetryOptions {
  settings: NodeSettingsStore;
  pool: BotPool;
  tracker: InventoryTracker;
  versions: GameVersion;
  nodeVersion: string;
  log: (s: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class Telemetry {
  private readonly queue: BanReport[] = [];
  private seenSuspended = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sent = 0;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;
  constructor(private readonly o: TelemetryOptions) {
    this.now = o.now ?? Date.now;
    // Everything already suspended at boot is history, not news.
    for (const a of o.pool.every()) if (a.suspended) this.seenSuspended.add(a.guid);
  }

  get enabled(): boolean {
    const t = this.o.settings.get().telemetry;
    return t.enabled && !!t.hubUrl;
  }
  setEnabled(enabled: boolean, hubUrl?: string): void {
    this.o.settings.update((s) => {
      s.telemetry.enabled = enabled;
      if (hubUrl !== undefined) s.telemetry.hubUrl = hubUrl.trim().replace(/\/$/, "");
    });
    this.o.log(`telemetry: ${this.enabled ? `on, reporting to ${this.o.settings.get().telemetry.hubUrl}` : "off"}`);
  }

  hashAccount(email: string): string {
    return createHash("sha256").update(this.o.settings.get().telemetry.salt + email.toLowerCase()).digest("base64url").slice(0, 32);
  }

  /** What the account was last doing, from the roster's assignment. */
  private laneOf(guid: string): Lane {
    const acc = this.o.pool.byGuid(guid);
    if (!acc) return "unknown";
    switch (acc.assignedKind) {
      case "deposit":
      case "withdraw":
        return "owner-trade";
      case "consolidate_give":
      case "consolidate_take":
        return "idle";
      default:
        return acc.online ? "idle" : "unknown";
    }
  }

  /** Look for suspensions the roster learned since the last tick. Always runs; sending is what opt-in gates. */
  tick(): BanReport[] {
    const fresh: BanReport[] = [];
    for (const acc of this.o.pool.every()) {
      if (!acc.suspended || this.seenSuspended.has(acc.guid)) continue;
      this.seenSuspended.add(acc.guid);
      const items = Object.values(this.o.tracker.instancesFor(acc.botGuid)).length;
      const r: BanReport = {
        account: this.hashAccount(acc.guid), suspendedAt: this.now(), lastSeenAt: this.o.tracker.verifiedAt(acc.botGuid) ?? null,
        lastLane: this.laneOf(acc.guid), heldItems: items, seasonal: acc.seasonal, nodeVersion: this.o.nodeVersion, build: this.o.versions.current,
      };
      fresh.push(r);
      if (this.queue.length < MAX_QUEUE) this.queue.push(r);
    }
    if (fresh.length) this.o.log(`telemetry: ${fresh.length} new suspension(s) noted${this.enabled ? "" : " (not sent: telemetry is off)"}`);
    return fresh;
  }

  /** Send what is queued. Resolves the number sent. */
  async flush(): Promise<number> {
    this.tick();
    if (!this.enabled || !this.queue.length) return 0;
    const batch = this.queue.slice();
    const url = `${this.o.settings.get().telemetry.hubUrl}/api/v1/telemetry/bans`;
    try {
      const res = await (this.o.fetchImpl ?? fetch)(url, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reports: batch }), signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.queue.splice(0, batch.length);
      this.sent += batch.length;
      this.lastFlushAt = this.now();
      this.lastError = null;
      return batch.length;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.o.log(`telemetry: flush failed (${this.lastError}); ${this.queue.length} report(s) kept`);
      return 0;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), TELEMETRY_FLUSH_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  status(): TelemetryStatus {
    const t = this.o.settings.get().telemetry;
    return { enabled: t.enabled, hubUrl: t.hubUrl, queued: this.queue.length, sent: this.sent, lastFlushAt: this.lastFlushAt, lastError: this.lastError };
  }
}
