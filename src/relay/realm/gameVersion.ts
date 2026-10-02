// The game build string sent in HELLO. It changes with every client update
// and the server kicks stale builds with `s.update_client`, so instead of a
// hand-bumped env var the fleet follows a published feed of the live build
// (a small "Key: value" text file next to the extracted global-metadata).
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_GAME_VERSION_URL = "https://rotmg.dia4a.com/global-metadata.txt";
export const DEFAULT_GAME_VERSION = "7.0.0.0.0";
const DEFAULT_POLL_S = 300;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE = "gameVersion.txt";

export interface BuildInfo {
  /** The `Game Version` line: the build string the client sends in HELLO. */
  gameVersion: string;
  /** Hash of the metadata file the feed was generated from. */
  metadataVersion: string;
  updatedAt: string;
}

const BUILD_RE = /^\d+(\.\d+)+$/;

/** Parse the feed's `Key: value` lines; null when no usable build is present. */
export function parseBuildInfo(text: string): BuildInfo | null {
  const fields = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(":");
    if (i <= 0) continue;
    fields.set(raw.slice(0, i).trim().toLowerCase(), raw.slice(i + 1).trim());
  }
  const gameVersion = fields.get("game version") ?? "";
  if (!BUILD_RE.test(gameVersion)) return null;
  return { gameVersion, metadataVersion: fields.get("version") ?? "", updatedAt: fields.get("last updated") ?? "" };
}

export interface GameVersionOptions {
  /** What HELLO sends until the feed answers (and if it never does). */
  seed: string;
  /** Feed URL; null disables polling and pins `seed`. */
  url: string | null;
  /** Last good build is written here so a restart with the feed down still has it. */
  cacheFile?: string;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export class GameVersion {
  private value: string;
  private readonly url: string | null;
  private readonly cacheFile?: string;
  private readonly pollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<boolean> | null = null;
  private readonly listeners = new Set<(version: string, previous: string) => void>();
  /** Last feed contents that parsed, for status pages. */
  lastInfo: BuildInfo | null = null;
  lastFetchAt = 0;
  lastError: string | null = null;

  constructor(opts: GameVersionOptions) {
    this.value = opts.seed || DEFAULT_GAME_VERSION;
    this.url = opts.url;
    this.cacheFile = opts.cacheFile;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_S * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  /** The build string to send right now. */
  get current(): string {
    return this.value;
  }
  get polling(): boolean {
    return this.url !== null;
  }

  onChange(fn: (version: string, previous: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Fetch the feed once. Resolves true when the build changed. Concurrent
   * calls share one request. Never throws: a bad fetch keeps the last value.
   */
  refresh(): Promise<boolean> {
    if (!this.url) return Promise.resolve(false);
    if (!this.inflight) {
      this.inflight = this.fetchOnce(this.url).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async fetchOnce(url: string): Promise<boolean> {
    this.lastFetchAt = Date.now();
    let text: string;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/plain" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      this.lastError = `fetch: ${(e as Error).message}`;
      this.log(`GameVersion: feed unreachable (${this.lastError}); keeping ${this.value}`);
      return false;
    }
    const info = parseBuildInfo(text);
    if (!info) {
      this.lastError = `unparseable feed: ${JSON.stringify(text.slice(0, 80))}`;
      this.log(`GameVersion: ${this.lastError}; keeping ${this.value}`);
      return false;
    }
    this.lastError = null;
    this.lastInfo = info;
    if (info.gameVersion === this.value) return false;
    const previous = this.value;
    this.value = info.gameVersion;
    this.log(`GameVersion: build ${previous} -> ${info.gameVersion} (metadata ${info.metadataVersion || "?"}, updated ${info.updatedAt || "?"})`);
    this.writeCache();
    for (const fn of this.listeners) {
      try {
        fn(info.gameVersion, previous);
      } catch (e) {
        this.log(`GameVersion: listener failed: ${String(e)}`);
      }
    }
    return true;
  }

  private writeCache(): void {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, this.value + "\n");
    } catch (e) {
      this.log(`GameVersion: could not write ${this.cacheFile}: ${String(e)}`);
    }
  }

  /** Refresh now and keep polling. The timer never holds the process open. */
  start(): void {
    if (!this.url || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Env wiring for the fleet:
   *  - `GAME_VERSION_URL`: feed to follow (default the public metadata feed);
   *    `off` pins the seed and never polls.
   *  - `GAME_VERSION_POLL_S`: feed poll interval.
   *  - seed: `GAME_VERSION`, else `<dataDir>/gameVersion.txt` (the cache this
   *    writes), else `./gameVersion.txt`, else the compiled-in default.
   */
  static fromEnv(dataDir: string, log?: (line: string) => void): GameVersion {
    const cacheFile = path.join(dataDir, CACHE_FILE);
    let seed = (process.env.GAME_VERSION ?? "").trim();
    if (!seed) {
      for (const f of [cacheFile, CACHE_FILE]) {
        try {
          seed = fs.readFileSync(f, "utf8").trim();
          if (seed) break;
        } catch {
          // next candidate
        }
      }
    }
    const rawUrl = process.env.GAME_VERSION_URL;
    const url = rawUrl === undefined ? DEFAULT_GAME_VERSION_URL : ["", "off", "0", "false", "none"].includes(rawUrl.trim().toLowerCase()) ? null : rawUrl.trim();
    const pollS = Number(process.env.GAME_VERSION_POLL_S ?? DEFAULT_POLL_S);
    return new GameVersion({ seed, url, cacheFile, pollMs: (Number.isFinite(pollS) && pollS > 0 ? pollS : DEFAULT_POLL_S) * 1000, log });
  }
}
