// Server load, automatic. Realm reports every server's usage on
// account/servers (the list the official client shows at login, 0..1 per
// server). The site only takes deposits and withdraws on servers at or under
// its load limit, so this watcher pulls the list every few seconds with any
// online bot's token and hands it to the site (lib/serverUsage when the
// fleet is embedded), which turns busy servers off and back on by itself.
import type { GameClient } from "../client/gameClient";
import { getServers, type ServerEntry } from "../realm/api";
import type { ServerUsageReport, SiteApi } from "./siteApi";

export const SERVER_USAGE_REFRESH_MS = Number(process.env.SERVER_USAGE_REFRESH_SECONDS ?? 30) * 1000;

export interface ServerUsageWatchOptions {
  /** Live clients: any authenticated one lends its token for the list. */
  clients: Map<string, GameClient>;
  /** Where readings go; null (no site) keeps them for status only. */
  api: Pick<SiteApi, "reportServerUsage"> | null;
  log: (line: string) => void;
  now?: () => number;
  /** Test hook: replaces the HTTP call. */
  fetchServers?: (token: string, proxy: GameClient["proxy"]) => Promise<ServerEntry[] | null>;
}
export interface ServerUsageWatchStatus {
  servers: ServerUsageReport[];
  fetchedAt: number | null;
  lastFetchError: string | null;
  /** How many refreshes found no bot online to lend a token. */
  skippedNoLender: number;
}

export class ServerUsageWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private servers: ServerUsageReport[] = [];
  private fetchedAt: number | null = null;
  private lastFetchError: string | null = null;
  private skippedNoLender = 0;
  private readonly now: () => number;

  constructor(private readonly o: ServerUsageWatchOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), SERVER_USAGE_REFRESH_MS);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  status(): ServerUsageWatchStatus {
    return { servers: this.servers, fetchedAt: this.fetchedAt, lastFetchError: this.lastFetchError, skippedNoLender: this.skippedNoLender };
  }

  /** Pull the list with any online bot's token and report it. False when nothing was reported. */
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
    if (!lender) {
      this.skippedNoLender++;
      return false;
    }
    let list: ServerEntry[] | null;
    let error: string | null = null;
    try {
      if (this.o.fetchServers) list = await this.o.fetchServers(lender.token, lender.proxy);
      else {
        const r = await getServers(lender.token, lender.proxy);
        list = r.ok ? r.value : null;
        if (!r.ok) error = r.error.kind === "network" ? `network: ${r.error.detail}` : r.error.kind;
      }
    } catch (e) {
      list = null;
      error = String(e);
    }
    if (!list) {
      this.lastFetchError = error ?? "no list";
      if (this.lastFetchError !== error) this.o.log(`server_usage: fetch failed: ${this.lastFetchError}`);
      await this.o.api?.reportServerUsage(null, this.lastFetchError);
      return false;
    }
    this.lastFetchError = null;
    this.onServers(list);
    return true;
  }

  /** A fresh list. Logs only when the set of busy servers changes. */
  onServers(list: ServerEntry[]): void {
    const report = list.filter((s) => !s.adminOnly).map((s) => ({ name: s.name, usage: s.usage }));
    const busyBefore = this.servers.filter((s) => s.usage > 0).map((s) => s.name).sort().join(",");
    const busyNow = report.filter((s) => s.usage > 0).map((s) => s.name).sort().join(",");
    if (busyBefore !== busyNow) this.o.log(`server_usage: loaded servers now ${busyNow ? busyNow.split(",").map((n) => `${n} ${Math.round((report.find((s) => s.name === n)?.usage ?? 0) * 100)}%`).join(", ") : "none"}`);
    this.servers = report;
    this.fetchedAt = this.now();
    void this.o.api?.reportServerUsage(report);
  }
}
