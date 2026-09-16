// Realm's server IPs, kept current. constants.ts ships a table so the first
// login can resolve a host, but servers move; a node in the wild must not
// depend on a release for that. account/servers (the list the official
// client shows at login) carries every server's address, so the node reads
// it at boot from a cache, refreshes it with the first token it gets, and
// keeps it fresh from the server-usage watcher after that.
import fs from "node:fs";
import path from "node:path";
import type { Proxy } from "../net/proxy";
import { getServers, type ServerEntry } from "./api";
import { SERVER_IPS, SERVER_NAMES } from "./constants";

export const SERVER_LIST_CACHE_FILE = "servers.json";
/** A list older than this is refreshed before the next login. */
export const SERVER_LIST_STALE_MS = 60 * 60 * 1000;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Rewrite the shared tables in place. Returns the names whose address changed or appeared. */
export function applyServerList(entries: ServerEntry[]): string[] {
  const changed: string[] = [];
  for (const e of entries) {
    if (!e.name || !IPV4_RE.test(e.dns)) continue;
    if (SERVER_IPS[e.name] !== e.dns) changed.push(e.name);
    SERVER_IPS[e.name] = e.dns;
  }
  for (const k of Object.keys(SERVER_NAMES)) delete SERVER_NAMES[k];
  for (const [n, ip] of Object.entries(SERVER_IPS)) SERVER_NAMES[ip] = n;
  return changed;
}

export class ServerList {
  fetchedAt = 0;
  lastError: string | null = null;
  private inflight: Promise<boolean> | null = null;
  constructor(
    private readonly cacheFile: string | null,
    private readonly log: (s: string) => void = () => {},
    private readonly fetchImpl: (token: string, proxy: Proxy | null) => Promise<ServerEntry[] | null> = async (token, proxy) => {
      const r = await getServers(token, proxy);
      if (!r.ok) throw new Error(r.error.kind === "network" ? r.error.detail : r.error.kind);
      return r.value;
    },
    private readonly now: () => number = Date.now,
  ) {
    this.loadCache();
  }
  static at(dataDir: string, log?: (s: string) => void): ServerList {
    return new ServerList(path.join(dataDir, SERVER_LIST_CACHE_FILE), log);
  }

  private loadCache(): void {
    if (!this.cacheFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")) as { fetchedAt?: number; servers?: ServerEntry[] };
      if (Array.isArray(raw.servers)) {
        const changed = applyServerList(raw.servers);
        this.fetchedAt = Number(raw.fetchedAt) || 0;
        if (changed.length) this.log(`servers: cache moved ${changed.length} address(es) from the built-in table: ${changed.join(", ")}`);
      }
    } catch {
      // no cache yet
    }
  }

  get stale(): boolean {
    return this.now() - this.fetchedAt > SERVER_LIST_STALE_MS;
  }

  /** A list that arrived some other way (the usage watcher polls it anyway). */
  apply(entries: ServerEntry[]): string[] {
    const changed = applyServerList(entries);
    this.fetchedAt = this.now();
    this.lastError = null;
    if (changed.length) this.log(`servers: ${changed.length} address(es) changed: ${changed.map((n) => `${n}=${SERVER_IPS[n]}`).join(", ")}`);
    if (this.cacheFile) {
      try {
        fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
        fs.writeFileSync(this.cacheFile, JSON.stringify({ fetchedAt: this.fetchedAt, servers: entries }, null, 2) + "\n");
      } catch (e) {
        this.log(`servers: could not write ${this.cacheFile}: ${String(e)}`);
      }
    }
    return changed;
  }

  /** Fetch with `token` when the list is stale. Never throws; resolves true when a fresh list was applied. */
  refreshIfStale(token: string, proxy: Proxy | null): Promise<boolean> {
    if (!this.stale) return Promise.resolve(false);
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const list = await this.fetchImpl(token, proxy);
          if (!list) return false;
          this.apply(list);
          return true;
        } catch (e) {
          this.lastError = String((e as Error).message ?? e);
          this.log(`servers: refresh failed (${this.lastError}); keeping the known table`);
          return false;
        } finally {
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }

  status(): { fetchedAt: number; stale: boolean; lastError: string | null; servers: Record<string, string> } {
    return { fetchedAt: this.fetchedAt, stale: this.stale, lastError: this.lastError, servers: { ...SERVER_IPS } };
  }
}
