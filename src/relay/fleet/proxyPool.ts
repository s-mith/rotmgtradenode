// Exit-IP assignment: one live bot per host, accounts pinned to hosts by
// rendezvous hashing. Port of the proxy half of pyrelay's ClientManager.
//
// The host list comes from PROXIES_URL (a Webshare download link) when set,
// with the last good download cached to PROXIES_FILE so a Webshare outage at
// boot is survivable; otherwise straight from the file. Operators can switch
// individual hosts off from the dev console; that flag persists next to the
// cache in proxy_settings.json and survives both restarts and refreshes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseProxyList, type Proxy } from "../net/proxy";

export const PROXY_PIN_DEPTH = Math.max(1, Number(process.env.PROXY_PIN_DEPTH ?? 3));
export const PROXY_BENCH_AFTER_FAILS = Math.max(1, Number(process.env.PROXY_BENCH_AFTER_FAILS ?? 2));
const PIN_NOTE_INTERVAL_MS = Number(process.env.PROXY_PIN_NOTE_INTERVAL_SECONDS ?? 60) * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export interface ProxySource {
  /** Download link; null means the file is the only source. */
  url: string | null;
  /** proxies.txt: the source when there is no URL, the cache when there is. */
  file: string | null;
  /** Where the enabled/disabled flags live; null keeps them in memory only. */
  stateFile?: string | null;
  fetch?: typeof fetch;
}

export interface ProxyHostReport {
  host: string;
  port: number;
  type: 4 | 5;
  enabled: boolean;
  ok: number;
  fail: number;
  benched: boolean;
  benchedUntil: number | null;
  inUse: boolean;
  usedBy: string | null;
}

export interface ProxySourceStatus {
  urlConfigured: boolean;
  file: string | null;
  /** Where the current list came from. */
  loadedFrom: "url" | "file" | "none";
  fetchedAt: number | null;
  lastError: string | null;
  refreshing: boolean;
}

/** PROXIES_URL / PROXIES_FILE as the fleet and accountgen both read them. */
export function proxySourceFromEnv(dataDir: string): ProxySource {
  const url = (process.env.PROXIES_URL ?? "").trim() || null;
  const explicit = process.env.PROXIES_FILE;
  const inData = path.join(dataDir, "proxies.txt");
  const file = explicit ?? (url || fs.existsSync(inData) ? inData : "proxies.txt");
  return { url, file, stateFile: path.join(dataDir, "proxy_settings.json") };
}

export class ProxyPool {
  private byHost = new Map<string, Proxy>();
  private hostRank = new Map<string, number>();
  private readonly preference = new Map<string, string[]>();
  private readonly lastUsed = new Map<string, number>();
  private readonly pinNoteAt = new Map<string, number>();
  /** host -> guid holding it. */
  private readonly occupied = new Map<string, string>();
  /** host -> recent outcome tallies and the moment it was benched until. */
  private readonly health = new Map<string, { ok: number; fail: number; lastFail: number; benchedUntil: number }>();
  /** Hosts an operator switched off. Kept even for hosts not currently listed. */
  private readonly disabled = new Set<string>();
  private readonly source: ProxySource;
  private status: ProxySourceStatus;
  private refreshInFlight: Promise<{ ok: boolean; count: number; error: string | null }> | null = null;

  constructor(proxies: Proxy[], source: Partial<ProxySource> = {}) {
    this.source = { url: source.url ?? null, file: source.file ?? null, stateFile: source.stateFile ?? null, fetch: source.fetch };
    this.status = { urlConfigured: !!this.source.url, file: this.source.file, loadedFrom: "none", fetchedAt: null, lastError: null, refreshing: false };
    this.loadState();
    this.replace(proxies, proxies.length ? "file" : "none", { quiet: true });
    if (this.byHost.size) {
      console.log(`ProxyPool: ${proxies.length} proxies, ${this.byHost.size} distinct exit IPs (${this.enabledHosts().length} enabled); accounts pinned, PROXY_PIN_DEPTH=${PROXY_PIN_DEPTH}`);
    } else if (!this.source.url) {
      console.log("ProxyPool: WARNING — no proxies loaded; every bot will connect from this host's IP");
    }
  }

  static fromFile(file: string, source: Partial<ProxySource> = {}): ProxyPool {
    let body = "";
    try {
      body = fs.readFileSync(file, "utf8");
    } catch (e) {
      console.log(`ProxyPool: failed to read ${file}: ${String(e)}`);
    }
    return new ProxyPool(parseProxyList(body), { file, ...source });
  }

  /** Sync boot: the cached file now, the URL on the first refresh(). */
  static fromSource(source: ProxySource): ProxyPool {
    if (source.file && fs.existsSync(source.file)) return ProxyPool.fromFile(source.file, source);
    return new ProxyPool([], source);
  }

  // --- source -------------------------------------------------------------------

  sourceStatus(): ProxySourceStatus {
    return { ...this.status, refreshing: this.refreshInFlight !== null };
  }

  /** Re-download the list from PROXIES_URL and swap it in. Coalesces callers. */
  refresh(): Promise<{ ok: boolean; count: number; error: string | null }> {
    if (!this.source.url) return Promise.resolve({ ok: false, count: this.byHost.size, error: "PROXIES_URL not configured" });
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<{ ok: boolean; count: number; error: string | null }> {
    const url = this.source.url!;
    const doFetch = this.source.fetch ?? fetch;
    let body: string;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.text();
    } catch (e) {
      const error = `fetch failed: ${(e as Error).message}`;
      this.status.lastError = error;
      console.log(`ProxyPool: refresh from PROXIES_URL ${error}; keeping ${this.byHost.size} host(s)`);
      return { ok: false, count: this.byHost.size, error };
    }
    const proxies = parseProxyList(body);
    if (!proxies.length) {
      const error = `download had no usable proxy lines (${body.length} bytes)`;
      this.status.lastError = error;
      console.log(`ProxyPool: ${error}; keeping ${this.byHost.size} host(s)`);
      return { ok: false, count: this.byHost.size, error };
    }
    this.replace(proxies, "url");
    this.status.fetchedAt = Date.now();
    this.status.lastError = null;
    if (this.source.file) {
      try {
        fs.mkdirSync(path.dirname(this.source.file), { recursive: true });
        fs.writeFileSync(this.source.file, body);
      } catch (e) {
        console.log(`ProxyPool: failed to cache the list to ${this.source.file}: ${String(e)}`);
      }
    }
    return { ok: true, count: this.byHost.size, error: null };
  }

  /** Swap the host list. Pins are recomputed; health, occupancy and the
   *  enabled flags carry over for hosts that are still listed. */
  replace(proxies: Proxy[], loadedFrom: ProxySourceStatus["loadedFrom"], opts: { quiet?: boolean } = {}): void {
    const next = new Map<string, Proxy>();
    for (const p of proxies) if (!next.has(p.host)) next.set(p.host, p);
    const added = [...next.keys()].filter((h) => !this.byHost.has(h));
    const removed = [...this.byHost.keys()].filter((h) => !next.has(h));
    this.byHost = next;
    this.hostRank = new Map([...next.keys()].map((h, i) => [h, i]));
    this.preference.clear();
    for (const h of removed) {
      this.health.delete(h);
      this.lastUsed.delete(h);
    }
    const sameSource = this.status.loadedFrom === loadedFrom;
    this.status.loadedFrom = loadedFrom;
    // A periodic refresh that finds the same list says nothing.
    if (!opts.quiet && (added.length || removed.length || !sameSource)) {
      const stillHeld = removed.filter((h) => this.occupied.has(h));
      console.log(`ProxyPool: list from ${loadedFrom}: ${next.size} exit IP(s), +${added.length} -${removed.length}${stillHeld.length ? ` (${stillHeld.length} removed host(s) still hold a live bot until it disconnects)` : ""}; ${this.enabledHosts().length} enabled`);
    }
  }

  // --- operator enable/disable -------------------------------------------------

  private loadState(): void {
    const file = this.source.stateFile;
    if (!file) return;
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { disabled?: unknown };
      if (Array.isArray(raw?.disabled)) for (const h of raw.disabled) if (typeof h === "string") this.disabled.add(h);
      if (this.disabled.size) console.log(`ProxyPool: ${this.disabled.size} host(s) disabled by operator (${file})`);
    } catch (e) {
      console.log(`ProxyPool: failed to load ${file}: ${String(e)}`);
    }
  }
  private saveState(): void {
    const file = this.source.stateFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ disabled: [...this.disabled].sort() }, null, 2));
    } catch (e) {
      console.log(`ProxyPool: failed to write ${file}: ${String(e)}`);
    }
  }

  isEnabled(host: string): boolean {
    return !this.disabled.has(host);
  }
  /** Switch one host on or off. A bot already on a disabled host keeps its
   *  connection; the host just isn't handed out again. Unknown host -> false. */
  setEnabled(host: string, enabled: boolean): boolean {
    if (!this.byHost.has(host) && !this.disabled.has(host)) return false;
    const was = this.isEnabled(host);
    if (enabled) this.disabled.delete(host);
    else this.disabled.add(host);
    if (was !== enabled) {
      this.saveState();
      console.log(`ProxyPool: ${host} ${enabled ? "enabled" : "disabled"} by operator${!enabled && this.occupied.has(host) ? ` (still in use by ${this.occupied.get(host)} until it disconnects)` : ""}`);
    }
    return true;
  }
  setAllEnabled(enabled: boolean): number {
    let changed = 0;
    for (const h of this.byHost.keys()) {
      if (this.isEnabled(h) !== enabled) {
        changed++;
        if (enabled) this.disabled.delete(h);
        else this.disabled.add(h);
      }
    }
    if (enabled) this.disabled.clear(); // forget stale hosts too
    if (changed) {
      this.saveState();
      console.log(`ProxyPool: operator ${enabled ? "enabled" : "disabled"} all hosts (${changed} changed)`);
    }
    return changed;
  }
  private enabledHosts(): string[] {
    return [...this.byHost.keys()].filter((h) => !this.disabled.has(h));
  }

  // --- health --------------------------------------------------------------------

  /** Record how a connection through `host` went. Repeated failures with no
   *  success in between bench the host for a growing interval, so a dead exit
   *  stops being handed out after one or two tries instead of forever. */
  noteResult(host: string, ok: boolean): void {
    if (!this.byHost.has(host)) return;
    const h = this.health.get(host) ?? { ok: 0, fail: 0, lastFail: 0, benchedUntil: 0 };
    if (ok) {
      h.ok++;
      h.fail = 0;
      h.benchedUntil = 0;
    } else {
      h.fail++;
      h.lastFail = Date.now();
      if (h.fail >= PROXY_BENCH_AFTER_FAILS) {
        const mins = Math.min(60, 2 ** (h.fail - PROXY_BENCH_AFTER_FAILS + 1));
        h.benchedUntil = Date.now() + mins * 60_000;
        console.log(`ProxyPool: ${host} failed ${h.fail}x in a row — benched ${mins}m`);
      }
    }
    this.health.set(host, h);
  }
  isBenched(host: string, now = Date.now()): boolean {
    return (this.health.get(host)?.benchedUntil ?? 0) > now;
  }
  /** The full descriptor for a listed host, credentials included. */
  entry(host: string): Proxy | undefined {
    return this.byHost.get(host);
  }
  healthReport(): ProxyHostReport[] {
    const now = Date.now();
    return [...this.byHost.values()].map((p) => {
      const h = this.health.get(p.host);
      const benched = this.isBenched(p.host, now);
      return {
        host: p.host, port: p.port, type: p.type, enabled: this.isEnabled(p.host),
        ok: h?.ok ?? 0, fail: h?.fail ?? 0, benched, benchedUntil: benched ? h!.benchedUntil : null,
        inUse: this.occupied.has(p.host), usedBy: this.occupied.get(p.host) ?? null,
      };
    });
  }

  // --- assignment ----------------------------------------------------------------

  /** How many bots can be online at once; null when no pool is configured. */
  exclusiveCapacity(): number | null {
    return this.byHost.size ? this.enabledHosts().length : null;
  }
  get configured(): boolean {
    return this.byHost.size > 0;
  }
  occupiedCount(): number {
    return this.occupied.size;
  }

  /** This account's hosts, best first. Stable across restarts and pool edits. */
  preferenceFor(guid: string): string[] {
    let pref = this.preference.get(guid);
    if (!pref) {
      const key = Buffer.from(guid, "utf8");
      pref = [...this.byHost.keys()].sort((a, b) => {
        const ha = createHash("md5").update(a, "utf8").update(key).digest("hex");
        const hb = createHash("md5").update(b, "utf8").update(key).digest("hex");
        return ha < hb ? 1 : ha > hb ? -1 : 0;
      });
      this.preference.set(guid, pref);
    }
    return pref;
  }

  /** Claim a host for `guid`, or null when every host is taken. */
  claim(guid: string): Proxy | null {
    if (!this.byHost.size) return null;
    const now = Date.now();
    const free = this.enabledHosts().filter((h) => !this.occupied.has(h));
    let usable = free.filter((h) => !this.isBenched(h, now));
    // A fully benched pool is still a pool: better a doubtful exit than none.
    if (!usable.length) usable = free;
    if (!usable.length) return null;
    const pref = this.preferenceFor(guid);
    const home = pref[0];
    for (const h of pref.slice(0, PROXY_PIN_DEPTH)) {
      if (usable.includes(h)) {
        this.lastUsed.set(h, now);
        this.occupied.set(h, guid);
        return this.byHost.get(h)!;
      }
    }
    usable.sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0) || (this.hostRank.get(a) ?? 0) - (this.hostRank.get(b) ?? 0));
    const host = usable[0];
    if (now - (this.pinNoteAt.get(guid) ?? 0) >= PIN_NOTE_INTERVAL_MS) {
      this.pinNoteAt.set(guid, now);
      console.log(`ProxyPool: ${guid} is not on its pinned exit IP ${home}; all ${PROXY_PIN_DEPTH} pinned hosts are taken — falling back to ${host}`);
    }
    this.lastUsed.set(host, now);
    this.occupied.set(host, guid);
    return this.byHost.get(host)!;
  }

  release(guid: string): void {
    for (const [h, g] of this.occupied) if (g === guid) this.occupied.delete(h);
  }

  /** A host for one HTTP probe about `guid`; claims nothing. */
  probeFor(guid: string): Proxy | null {
    if (!this.byHost.size) return null;
    const usable = new Set(this.enabledHosts().filter((h) => !this.occupied.has(h)));
    if (!usable.size) return null;
    for (const h of this.preferenceFor(guid)) if (usable.has(h)) return this.byHost.get(h)!;
    return this.byHost.get([...usable][0])!;
  }
}
