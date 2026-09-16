// The season rollover, automatic. Realm converts every seasonal character
// to non-seasonal the moment a season ends (and moves the seasonal Gift
// Chest to the non-seasonal vault), so every `seasonal` flag the pool holds
// goes stale at once and the dispatcher would keep staffing a seasonal pool
// nobody is in. This watcher follows Realm's own clock (season/seasonInfo,
// refreshed hourly with any online bot's token) and marks every account
// non-seasonal once, the minute the end passes — including at boot after a
// downtime that spanned the boundary, and when a refresh already returns
// the next season. A bot whose char list still disagrees re-stamps itself on
// its next login, as before.
import type { GameClient } from "../client/gameClient";
import { getSeasonInfo, type SeasonInfo } from "../realm/api";
import type { BackpackStore } from "./backpacks";

export const SEASON_REFRESH_MS = Number(process.env.SEASON_REFRESH_MINUTES ?? 60) * 60_000;
export const SEASON_CHECK_MS = Number(process.env.SEASON_CHECK_SECONDS ?? 60) * 1000;

/** Whether the rollover for `season` is owed: its end has passed and it was not rolled yet. Pure. */
export function rolloverDue(season: { id: string; end: number } | null, rolledId: string | null, nowSec: number): boolean {
  return !!season && nowSec >= season.end && rolledId !== season.id;
}

export interface SeasonPool {
  markAllNonseasonal(): { changed: number; total: number };
}
export interface SeasonWatchOptions {
  store: BackpackStore;
  pool: SeasonPool;
  /** Live clients: any authenticated one lends its token for the clock. */
  clients: Map<string, GameClient>;
  log: (line: string) => void;
  now?: () => number;
  /** Test hook: replaces the HTTP call. */
  fetchSeason?: (token: string, proxy: GameClient["proxy"]) => Promise<SeasonInfo | null>;
}
export interface SeasonWatchStatus {
  season: (SeasonInfo & { fetchedAt: number }) | null;
  rolledSeasonId: string | null;
  endsInS: number | null;
  lastRoll: { at: number; seasonId: string; changed: number; total: number } | null;
  lastFetchError: string | null;
}

export class SeasonWatch {
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private lastRoll: SeasonWatchStatus["lastRoll"] = null;
  private refreshing = false;
  private lastFetchError: string | null = null;
  private readonly now: () => number;

  constructor(private readonly o: SeasonWatchOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.refreshTimer) return;
    this.check();
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), SEASON_REFRESH_MS);
    this.checkTimer = setInterval(() => this.check(), SEASON_CHECK_MS);
  }
  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.refreshTimer = null;
    this.checkTimer = null;
  }
  status(): SeasonWatchStatus {
    const season = this.o.store.currentSeason();
    return {
      season, rolledSeasonId: this.o.store.rolledFor(), endsInS: season ? Math.round(season.end - this.now() / 1000) : null,
      lastRoll: this.lastRoll, lastFetchError: this.lastFetchError,
    };
  }

  /** Pull the clock with any online bot's token; roll the stored season first if the answer is already its successor. */
  async refresh(): Promise<boolean> {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      return await this.refreshOnce();
    } finally {
      this.refreshing = false;
    }
  }
  private async refreshOnce(): Promise<boolean> {
    let lender: GameClient | null = null;
    for (const c of this.o.clients.values()) if (c.active && c.isReady && c.token) { lender = c; break; }
    if (!lender) return false;
    let s: SeasonInfo | null;
    try {
      if (this.o.fetchSeason) s = await this.o.fetchSeason(lender.token, lender.proxy);
      else {
        const r = await getSeasonInfo(lender.token, lender.proxy);
        s = r.ok ? r.value : null;
        if (!r.ok) this.lastFetchError = r.error.kind;
      }
    } catch (e) {
      this.lastFetchError = String(e);
      return false;
    }
    if (!s) return false;
    this.lastFetchError = null;
    this.onSeason(s);
    return true;
  }

  /** A fresh clock reading. */
  onSeason(s: SeasonInfo): void {
    const { store } = this.o;
    const prev = store.currentSeason();
    if (prev && prev.id !== s.id) {
      // The old season is over even if its end stamp lags the announcement.
      if (rolloverDue(prev, store.rolledFor(), Math.max(this.now() / 1000, prev.end))) this.roll(prev);
      this.o.log(`season: "${s.name}" (${s.id}) replaces "${prev.name}" — ends ${new Date(s.end * 1000).toISOString()}`);
    } else if (!prev) this.o.log(`season: "${s.name}" ends ${new Date(s.end * 1000).toISOString()}`);
    store.noteSeason(s, this.now());
    store.save();
    this.check();
  }

  /** Roll if the stored season's end has passed. Cheap; runs every minute and at boot. Until the clock is known, each minute also retries the fetch (the hourly one at boot usually finds every bot still down for the sweep). */
  check(): boolean {
    const { store } = this.o;
    if (!store.currentSeason() && !this.refreshing) void this.refresh();
    const season = store.currentSeason();
    if (!rolloverDue(season, store.rolledFor(), this.now() / 1000)) return false;
    this.roll(season!);
    return true;
  }

  private roll(season: { id: string; name: string; end: number }): void {
    const r = this.o.pool.markAllNonseasonal();
    this.o.store.noteRolled(season.id);
    this.o.store.save();
    this.lastRoll = { at: this.now() / 1000, seasonId: season.id, ...r };
    this.o.log(`season: "${season.name}" ended ${new Date(season.end * 1000).toISOString()} — marked all ${r.total} account(s) non-seasonal (${r.changed} were seasonal); accounts whose char list still says seasonal re-stamp themselves on their next login`);
  }
}
