// Small process-wide stores: trade holds, login codes, whisper queues, and
// the pool-wide settings file. Ports of TradeHold, LoginCode, IgnVerify and
// pool_settings.
import fs from "node:fs";
import path from "node:path";

/** Pause on player trade work while maintenance (the ban sweep) runs. */
export class TradeHold {
  private holds = new Map<string, number>();
  acquire(reason: string): void {
    if (!this.holds.has(reason)) this.holds.set(reason, Date.now());
  }
  release(reason: string): void {
    this.holds.delete(reason);
  }
  get active(): boolean {
    return this.holds.size > 0;
  }
  reason(): string | null {
    let best: [string, number] | null = null;
    for (const e of this.holds) if (!best || e[1] < best[1]) best = e;
    return best ? best[0] : null;
  }
  heldForMs(): number {
    let oldest = Infinity;
    for (const t of this.holds.values()) oldest = Math.min(oldest, t);
    return this.holds.size ? Date.now() - oldest : 0;
  }
}

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const EXPECT_TTL_MS = 180_000;
const VERIFIED_TTL_MS = 120_000;

/** Login by pasted /tell: codes the site minted and who sent them back. */
export class LoginCodes {
  private expected = new Map<string, number>();
  private verified = new Map<string, { ign: string; expiresAt: number }>();
  private listeners = new Set<(code: string, ign: string) => void>();
  /** `ttlMs`: how long the code is good for (the hub's sign-in codes last longer than the node's own). */
  register(code: string, ttlMs = EXPECT_TTL_MS): void {
    this.expected.set(code, Date.now() + Math.max(1_000, ttlMs));
  }
  /** Codes still waiting for their tell: while any is, the login desk is wanted (the dispatcher staffs it on demand). */
  pendingCount(): number {
    const now = Date.now();
    let n = 0;
    for (const exp of this.expected.values()) if (exp > now) n++;
    return n;
  }
  /** Hear every code the moment its tell arrives (the hub's login node passes them on). */
  onVerified(fn: (code: string, ign: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Feed every inbound tell. True when a registered code was found. */
  noteTell(name: string, text: string): boolean {
    const now = Date.now();
    for (const token of text.split(/\s+/)) {
      const code = token.trim();
      if (!CODE_RE.test(code)) continue;
      const exp = this.expected.get(code);
      if (exp === undefined || exp <= now) continue;
      this.expected.delete(code);
      // Realm writes some names as "Name,a19d,fe3" on the wire; the character is "Name".
      this.verified.set(code, { ign: name.split(",", 1)[0].trim(), expiresAt: now + VERIFIED_TTL_MS });
      for (const fn of this.listeners) {
        try {
          fn(code, name);
        } catch (e) {
          console.error("[login] code listener raised:", e);
        }
      }
      return true;
    }
    return false;
  }
  /** Single-use read. */
  state(code: string): { state: "verified"; ign: string } | { state: "pending" | "expired"; ign: null } {
    const now = Date.now();
    const v = this.verified.get(code);
    if (v && v.expiresAt > now) {
      this.verified.delete(code);
      return { state: "verified", ign: v.ign };
    }
    const e = this.expected.get(code);
    if (e !== undefined && e > now) return { state: "pending", ign: null };
    return { state: "expired", ign: null };
  }
}

const WHISPER_TTL_MS = 120_000;
const MAX_QUEUED_PER_BOT = 8;

/** Chat lines queued for a bot to send from its own packet loop. */
export class WhisperQueue {
  private pending = new Map<string, { text: string; expiresAt: number }[]>();
  queue(botGuid: string, text: string): boolean {
    const now = Date.now();
    const live = (this.pending.get(botGuid) ?? []).filter((w) => w.expiresAt > now);
    if (live.length >= MAX_QUEUED_PER_BOT) {
      this.pending.set(botGuid, live);
      return false;
    }
    live.push({ text, expiresAt: now + WHISPER_TTL_MS });
    this.pending.set(botGuid, live);
    return true;
  }
  take(botGuid: string): string[] {
    const now = Date.now();
    const q = this.pending.get(botGuid) ?? [];
    this.pending.delete(botGuid);
    return q.filter((w) => w.expiresAt > now).map((w) => w.text);
  }
  pendingCount(): number {
    const now = Date.now();
    let n = 0;
    for (const q of this.pending.values()) for (const w of q) if (w.expiresAt > now) n++;
    return n;
  }
}

/** Pool-wide operator knobs, persisted to <dataDir>/pool_settings.json.
 *  `pool_has_backpack` is kept for the settings API/UI but is INERT since
 *  capacity became strictly per bot (2026-09): nothing reads it for slots. */
export class PoolSettings {
  private state = { pool_has_backpack: false };
  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (raw && typeof raw === "object" && "pool_has_backpack" in raw) this.state.pool_has_backpack = Boolean(raw.pool_has_backpack);
        console.log(`pool_settings: loaded ${JSON.stringify(this.state)} from ${file}`);
      }
    } catch (e) {
      console.log(`pool_settings: failed to load ${file}: ${String(e)}`);
    }
  }
  static at(dataDir: string): PoolSettings {
    return new PoolSettings(path.join(dataDir, "pool_settings.json"));
  }
  all(): { pool_has_backpack: boolean } {
    return { ...this.state };
  }
  get poolHasBackpack(): boolean {
    return this.state.pool_has_backpack;
  }
  setPoolHasBackpack(v: boolean): boolean {
    const next = Boolean(v);
    if (this.state.pool_has_backpack !== next) {
      this.state.pool_has_backpack = next;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
      } catch (e) {
        console.log(`pool_settings: failed to write ${this.file}: ${String(e)}`);
      }
      console.log(`pool_settings: pool_has_backpack -> ${next}`);
    }
    return next;
  }
}
