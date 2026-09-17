// Protocol-break safety (design doc §8). A Realm patch that changes packet
// ids kicks every bot that logs in with stale codecs, and a synchronised kick
// across every node is exactly the signal the ban rules exist to avoid. So
// the node only logs bots in on builds it has seen work: the ones compiled
// in, the ones it learned on this machine, and the ones the owner trusts.
//
// On an unknown build the login gate is held. Two ways out:
//   - a rotmgtradenode update whose compiled-in list names the build;
//   - a canary: ONE account logs in, must reach the world and hold it for
//     CANARY_HOLD_MS without a FAILURE, and the build is then recorded as
//     known. The canary is the owner's call (a button), never automatic.
// `trust` records a build without a canary, for an owner who knows better.
import type { GameClient } from "../client/gameClient";
import type { GameVersion } from "../realm/gameVersion";
import type { NodeSettingsStore } from "../../node/settings";
import { bringUp, BringUpRefused, takeDown, type FleetDeps } from "./bringUp";
import type { BotPool } from "./botPool";
import { DEFAULT_SERVER } from "../realm/constants";

/** Builds the shipped codecs were verified on. Bump with every release that follows a Realm patch. */
export const COMPILED_KNOWN_BUILDS: readonly string[] = ["7.0.0.0.0", "7.0.0.2.0"];
export const CANARY_CONNECT_MS = Number(process.env.CANARY_CONNECT_SECONDS ?? 120) * 1000;
export const CANARY_HOLD_MS = Number(process.env.CANARY_HOLD_SECONDS ?? 30) * 1000;

export type CanaryResult = { ok: true; build: string; ign: string; seconds: number } | { ok: false; build: string; reason: string };

export interface BuildGateStatus {
  build: string;
  known: boolean;
  held: boolean;
  reason: string | null;
  knownBuilds: string[];
  canary: { running: boolean; last: CanaryResult | null };
}

export interface BuildGateOptions {
  versions: GameVersion;
  deps: FleetDeps;
  pool: BotPool;
  settings: NodeSettingsStore;
  log: (s: string) => void;
  /** Extra builds to treat as known (tests). */
  compiled?: readonly string[];
}

export class BuildGate {
  private canaryRunning = false;
  private lastCanary: CanaryResult | null = null;
  private off: (() => void) | null = null;
  constructor(private readonly o: BuildGateOptions) {}

  private get knownBuilds(): Set<string> {
    return new Set([...(this.o.compiled ?? COMPILED_KNOWN_BUILDS), ...this.o.settings.get().knownBuilds]);
  }
  isKnown(build: string): boolean {
    return this.knownBuilds.has(build);
  }

  /** Apply the gate to the current build and follow every change. */
  start(): void {
    this.onBuild(this.o.versions.current);
    this.off = this.o.versions.onChange((v) => this.onBuild(v));
  }
  stop(): void {
    this.off?.();
    this.off = null;
  }

  onBuild(build: string): void {
    if (this.isKnown(build)) {
      if (this.o.deps.gate.holdReason?.startsWith("Realm build")) this.o.deps.gate.release();
      return;
    }
    this.o.deps.gate.hold(`Realm build ${build} is new to this node; waiting for a rotmgtradenode update, or run a canary login from the console`);
    // Bots already in world stay: the kick, if any, comes from the server.
  }

  /** The owner vouches for the build. */
  trust(build = this.o.versions.current): void {
    this.markKnown(build, "trusted by the owner");
  }
  /** The hub's operator confirmed these builds work with this node's codecs (docs/hub-protocol.md). */
  acceptFromHub(builds: string[]): void {
    for (const b of builds) if (!this.isKnown(b)) this.markKnown(b, "confirmed by the hub");
  }

  private markKnown(build: string, why: string): void {
    if (!this.isKnown(build)) {
      this.o.settings.update((s) => {
        if (!s.knownBuilds.includes(build)) s.knownBuilds.push(build);
      });
      this.o.log(`build gate: ${build} recorded as known (${why})`);
    }
    this.onBuild(this.o.versions.current);
  }

  status(): BuildGateStatus {
    const build = this.o.versions.current;
    return {
      build, known: this.isKnown(build), held: this.o.deps.gate.holdReason !== null, reason: this.o.deps.gate.holdReason,
      knownBuilds: [...this.knownBuilds].sort(), canary: { running: this.canaryRunning, last: this.lastCanary },
    };
  }

  /**
   * One login on the current build. Picks an idle, unsuspended account with
   * no lockout; refuses while another canary runs. The account is logged out
   * afterwards either way.
   */
  async canary(server = DEFAULT_SERVER): Promise<CanaryResult> {
    const build = this.o.versions.current;
    if (this.canaryRunning) return { ok: false, build, reason: "a canary is already running" };
    const acc = this.o.pool.all().find((a) => !a.suspended && !a.online && !a.inUse && this.o.deps.gate.lockoutRemainingMs(a.guid) === 0 && !this.o.deps.clients.has(a.guid));
    if (!acc) return this.finish({ ok: false, build, reason: "no idle account to try with" });
    this.canaryRunning = true;
    this.o.log(`build gate: canary ${acc.alias} logging in on ${build}`);
    const t0 = Date.now();
    let client: GameClient;
    try {
      client = await (this.o.deps.bringUp ?? bringUp)(this.o.deps, acc, server, { ignoreHold: true });
    } catch (e) {
      const why = e instanceof BringUpRefused ? `${e.verdict}: ${e.message}` : String(e);
      return this.finish({ ok: false, build, reason: `login refused (${why})` });
    }
    const verdict = await new Promise<CanaryResult>((resolve) => {
      let holdTimer: ReturnType<typeof setTimeout> | null = null;
      const connectTimer = setTimeout(() => done({ ok: false, build, reason: `not in world after ${CANARY_CONNECT_MS / 1000}s` }), CANARY_CONNECT_MS);
      const done = (r: CanaryResult) => {
        clearTimeout(connectTimer);
        if (holdTimer) clearTimeout(holdTimer);
        resolve(r);
      };
      client.on("failure", (ev) => done({ ok: false, build, reason: `FAILURE ${ev.kind}${"description" in ev ? `: ${ev.description}` : ""}` }));
      client.on("stopped", () => done({ ok: false, build, reason: "session dropped" }));
      client.on("inWorld", () => {
        holdTimer = setTimeout(() => done({ ok: true, build, ign: client.playerData.name, seconds: Math.round((Date.now() - t0) / 1000) }), CANARY_HOLD_MS);
      });
      if (client.objectId !== -1) client.emit("inWorld", client.objectId);
    });
    takeDown(this.o.deps, acc, "canary done");
    if (verdict.ok) this.markKnown(build, `canary ${verdict.ign} held the world for ${CANARY_HOLD_MS / 1000}s`);
    else this.o.log(`build gate: canary failed on ${build}: ${verdict.reason}`);
    return this.finish(verdict);
  }

  private finish(r: CanaryResult): CanaryResult {
    this.canaryRunning = false;
    this.lastCanary = r;
    return r;
  }
}
