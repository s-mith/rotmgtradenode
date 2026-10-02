// Exit-IP assignment: one live bot per host, accounts pinned to hosts by
// rendezvous hashing. Port of the proxy half of pyrelay's ClientManager.
//
// The host list is the one the owner pastes into the console's Proxies tab,
// saved to PROXIES_FILE and read back from it at boot. Operators can switch
// individual hosts off from the dev console; that flag persists next to the
// list in proxy_settings.json and survives both restarts and a new list.
import { tieCapsToExits } from "./constants";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseProxyList, parseProxyText, type Proxy, type ProxyLineReport } from "../net/proxy";

export const PROXY_PIN_DEPTH = Math.max(1, Number(process.env.PROXY_PIN_DEPTH ?? 3));
/** A gateway provider's list: one hostname, a different exit IP per port. Read each time so a test can set it. */
const EXIT_PER_PORT = () => ["1", "true", "yes", "on"].includes((process.env.PROXY_EXIT_PER_PORT ?? "").trim().toLowerCase());
/** How long an exit IP Realm banned stays out of use. */
export const PROXY_BAN_BENCH_MS = Number(process.env.PROXY_BAN_BENCH_MINUTES ?? 360) * 60_000;
export const PROXY_BENCH_AFTER_FAILS = Math.max(1, Number(process.env.PROXY_BENCH_AFTER_FAILS ?? 2));
const PIN_NOTE_INTERVAL_MS = Number(process.env.PROXY_PIN_NOTE_INTERVAL_SECONDS ?? 60) * 1000;
/** How often a job waiting for a free host (probeWhenFree) looks again. */
const PROBE_POLL_MS = 500;
/** How long an HTTP probe holds its host when the caller never gives it back: longer than any verify + snapshot + calendar read takes. */
export const PROBE_LEASE_MS = Number(process.env.PROXY_PROBE_LEASE_SECONDS ?? 120) * 1000;

export interface ProxySource {
  /** proxies.txt: the list the console saves, read at boot. */
  file: string | null;
  /** Where the enabled/disabled flags live; null keeps them in memory only. */
  stateFile?: string | null;
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
  /** Benched because Realm banned this exit IP (noteBan), not for failing. */
  banned: boolean;
  inUse: boolean;
  usedBy: string | null;
}

/** PROXIES_FILE as the fleet reads it. */
export function proxySourceFromEnv(dataDir: string): ProxySource {
  // The list the console's Proxies tab writes lives in the data dir.
  const file = process.env.PROXIES_FILE ?? path.join(dataDir, "proxies.txt");
  return { file, stateFile: path.join(dataDir, "proxy_settings.json") };
}

export class ProxyPool {
  private byHost = new Map<string, Proxy>();
  private hostRank = new Map<string, number>();
  private readonly preference = new Map<string, string[]>();
  private readonly lastUsed = new Map<string, number>();
  private readonly pinNoteAt = new Map<string, number>();
  /** host -> guid holding it. */
  private readonly occupied = new Map<string, string>();
  /** host -> an HTTP call (verify, snapshot, calendar, probe) going out through it for `guid`, until `until`. */
  private readonly probeLeases = new Map<string, { guid: string; until: number }>();
  /** host -> recent outcome tallies and the moment it was benched until. */
  private readonly health = new Map<string, { ok: number; fail: number; lastFail: number; benchedUntil: number; banned?: boolean }>();
  /** Hosts an operator switched off. Kept even for hosts not currently listed. */
  private readonly disabled = new Set<string>();
  private readonly source: ProxySource;

  constructor(proxies: Proxy[], source: Partial<ProxySource> = {}) {
    this.source = { file: source.file ?? null, stateFile: source.stateFile ?? null };
    this.loadState();
    this.replace(proxies, { quiet: true });
    if (this.byHost.size) {
      console.log(`ProxyPool: ${proxies.length} proxies, ${this.byHost.size} distinct exit IPs (${this.enabledHosts().length} enabled); accounts pinned, PROXY_PIN_DEPTH=${PROXY_PIN_DEPTH}`);
    } else {
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

  /** Sync boot: the list the console saved last. */
  static fromSource(source: ProxySource): ProxyPool {
    if (source.file && fs.existsSync(source.file)) return ProxyPool.fromFile(source.file, source);
    return new ProxyPool([], source);
  }

  // --- the list -----------------------------------------------------------------

  /**
   * A list the owner pasted in, one proxy per line in any of the shapes
   * sellers use (src/relay/net/proxy.ts readProxyLine). Replaces the live
   * pool and the file, so it survives a restart. Returns how many proxies it
   * holds now, and what each line was read as.
   */
  setList(text: string): { count: number; error: string | null; lines: ProxyLineReport[] } {
    const { proxies, lines } = parseProxyText(text);
    if (!proxies.length && text.trim()) return { count: 0, error: "None of these lines is a proxy the node can use. Put one proxy on each line, like host:port or host:port:username:password.", lines };
    this.replace(proxies);
    if (this.source.file) {
      try {
        fs.mkdirSync(path.dirname(this.source.file), { recursive: true });
        fs.writeFileSync(this.source.file, text.trim() ? text.replace(/\r\n/g, "\n").trim() + "\n" : "", { mode: 0o600 });
      } catch (e) {
        return { count: proxies.length, error: `The list works now but could not be saved, so it will be gone after a restart (${String(e)}).`, lines };
      }
    }
    return { count: proxies.length, error: null, lines };
  }
  /** The list as text, credentials included (the console runs on loopback). */
  listText(): string {
    return [...this.byHost.values()].map((p) => `${p.type === 4 ? "socks4://" : ""}${p.host}:${p.port}${p.username ? `:${p.username}:${p.password}` : ""}`).join("\n");
  }

  /** Swap the host list. Pins are recomputed; health, occupancy and the
   *  enabled flags carry over for hosts that are still listed. */
  replace(proxies: Proxy[], opts: { quiet?: boolean } = {}): void {
    // One entry per exit IP. By default a host is one exit, however many
    // ports it is listed on: two ports on one server usually share its IP,
    // and two accounts on one IP is what the pool exists to prevent. A
    // gateway provider (one hostname, a different exit per port) is opted in
    // with PROXY_EXIT_PER_PORT=1: its entries are keyed host:port. The same
    // host:port listed twice is one exit either way.
    const perPort = EXIT_PER_PORT();
    const portsOf = new Map<string, Set<number>>();
    for (const p of proxies) (portsOf.get(p.host) ?? portsOf.set(p.host, new Set()).get(p.host)!).add(p.port);
    const next = new Map<string, Proxy>();
    for (const p of proxies) {
      const id = perPort && portsOf.get(p.host)!.size > 1 ? `${p.host}:${p.port}` : p.host;
      if (!next.has(id)) next.set(id, p);
    }
    const shared = [...portsOf].filter(([, ports]) => ports.size > 1).map(([h]) => h);
    if (shared.length && !opts.quiet) {
      console.log(perPort
        ? `ProxyPool: ${shared.join(", ")} listed on several ports — each port counts as its own exit IP (PROXY_EXIT_PER_PORT=1)`
        : `ProxyPool: WARNING ${shared.join(", ")} listed on several ports — counted as ONE exit IP and only its first port is used; for a gateway provider with a different exit per port, set PROXY_EXIT_PER_PORT=1`);
    }
    const added = [...next.keys()].filter((h) => !this.byHost.has(h));
    const removed = [...this.byHost.keys()].filter((h) => !next.has(h));
    this.byHost = next;
    tieCapsToExits(this.exclusiveCapacity());
    this.hostRank = new Map([...next.keys()].map((h, i) => [h, i]));
    this.preference.clear();
    for (const h of removed) {
      this.health.delete(h);
      this.lastUsed.delete(h);
    }
    // The same list saved again says nothing.
    if (!opts.quiet && (added.length || removed.length)) {
      const stillHeld = removed.filter((h) => this.occupied.has(h));
      console.log(`ProxyPool: new list: ${next.size} exit IP(s), +${added.length} -${removed.length}${stillHeld.length ? ` (${stillHeld.length} removed host(s) still hold a live bot until it disconnects)` : ""}; ${this.enabledHosts().length} enabled`);
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
    tieCapsToExits(this.exclusiveCapacity());
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
      h.banned = false;
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
  /** The pool's key for a proxy it handed out: its host, or host:port for a host listed on several ports. */
  keyOf(p: Proxy): string {
    const hp = `${p.host}:${p.port}`;
    return this.byHost.has(hp) ? hp : p.host;
  }
  /**
   * Realm banned this exit IP: out of use for PROXY_BAN_BENCH_MS, even when
   * every other host is benched too (a banned exit only earns the next
   * account the same ban). A success through it later clears it.
   */
  noteBan(host: string): void {
    if (!this.byHost.has(host)) return;
    const h = this.health.get(host) ?? { ok: 0, fail: 0, lastFail: 0, benchedUntil: 0 };
    h.fail++;
    h.lastFail = Date.now();
    h.benchedUntil = Date.now() + PROXY_BAN_BENCH_MS;
    h.banned = true;
    this.health.set(host, h);
    console.log(`ProxyPool: ${host} was IP-banned by Realm — out of use for ${Math.round(PROXY_BAN_BENCH_MS / 60_000)}m`);
  }
  private isBanned(host: string, now = Date.now()): boolean {
    const h = this.health.get(host);
    return !!h?.banned && h.benchedUntil > now;
  }
  /**
   * Let back every host benched for failing (not one Realm banned): after the
   * computer slept, the failures were the sleep's, not the proxies'. Returns
   * how many came back.
   */
  clearBenches(now = Date.now()): number {
    let n = 0;
    for (const [host, h] of this.health) {
      if (h.banned && h.benchedUntil > now) continue;
      if (h.benchedUntil > now || h.fail > 0) n++;
      h.fail = 0;
      h.benchedUntil = 0;
    }
    if (n) console.log(`ProxyPool: ${n} host(s) let back after the computer woke up`);
    return n;
  }
  /** The proxies to check, by the host keys the console shows (all of them when `hosts` is empty). */
  entriesFor(hosts: string[] = []): { key: string; proxy: Proxy }[] {
    const all = [...this.byHost].map(([key, proxy]) => ({ key, proxy }));
    if (!hosts.length) return all;
    const want = new Set(hosts.map((h) => h.trim().toLowerCase()));
    return all.filter((e) => want.has(e.key.toLowerCase()) || want.has(`${e.proxy.host}:${e.proxy.port}`.toLowerCase()));
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
    return [...this.byHost].map(([key, p]) => {
      const h = this.health.get(key);
      const benched = this.isBenched(key, now);
      return {
        host: key, port: p.port, type: p.type, enabled: this.isEnabled(key),
        ok: h?.ok ?? 0, fail: h?.fail ?? 0, benched, benchedUntil: benched ? h!.benchedUntil : null, banned: this.isBanned(key, now),
        inUse: this.occupied.has(key), usedBy: this.occupied.get(key) ?? null,
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
    const free = this.enabledHosts().filter((h) => !this.occupied.has(h) && !this.leasedToOther(h, guid, now) && !this.isBanned(h, now));
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

  /** Whether an HTTP call for another account is going out through `host` right now. */
  private leasedToOther(host: string, guid: string, now = Date.now()): boolean {
    const l = this.probeLeases.get(host);
    if (!l) return false;
    if (l.until <= now) {
      this.probeLeases.delete(host);
      return false;
    }
    return l.guid !== guid;
  }

  /** The host an HTTP probe about `guid` would use right now; claims nothing (see leaseProbe). */
  probeFor(guid: string): Proxy | null {
    if (!this.byHost.size) return null;
    const now = Date.now();
    const usable = new Set(this.enabledHosts().filter((h) => !this.occupied.has(h) && !this.leasedToOther(h, guid, now) && !this.isBanned(h, now)));
    if (!usable.size) return null;
    for (const h of this.preferenceFor(guid)) if (usable.has(h)) return this.byHost.get(h)!;
    return this.byHost.get([...usable][0])!;
  }

  /**
   * A host for HTTP calls about `guid`, held so no other account logs in or
   * probes through it while the calls go out (one account per exit IP, HTTP
   * included). Held until releaseProbe(guid), or PROBE_LEASE_MS at most.
   */
  leaseProbe(guid: string, ms = PROBE_LEASE_MS): Proxy | null {
    const p = this.probeFor(guid);
    if (p) this.probeLeases.set(p.host, { guid, until: Date.now() + ms });
    return p;
  }
  /** Give back the hosts `guid`'s HTTP calls held. */
  releaseProbe(guid: string): void {
    for (const [h, l] of this.probeLeases) if (l.guid === guid) this.probeLeases.delete(h);
  }

  /**
   * A host for one HTTP call about `guid`, waiting for one to come free:
   * while every enabled host carries a bot there is none to spare, and the
   * call must not go out from this computer's own address instead. Looked
   * for again every half second until `until` (on the `now` clock) or until
   * the job is cancelled; null when none came free by then, or at once when
   * every host is switched off (no bot logging out frees one of those).
   * The host is leased to `guid` (leaseProbe): call releaseProbe when done.
   */
  async probeWhenFree(guid: string, until: number, o: { cancelled?: () => boolean; now?: () => number } = {}): Promise<Proxy | null> {
    const now = o.now ?? Date.now;
    for (;;) {
      const p = this.leaseProbe(guid);
      if (p || !this.enabledHosts().length || now() >= until || o.cancelled?.()) return p;
      await new Promise((r) => setTimeout(r, PROBE_POLL_MS));
    }
  }
  /** Whether any host is switched on: with none, waiting for a free one is pointless. */
  hasEnabledHost(): boolean {
    return this.enabledHosts().length > 0;
  }
  /** Why no host is free for an HTTP call, for a job that gave up waiting for one. */
  noFreeHostReason(): string {
    return this.enabledHosts().length ? "every proxy host is carrying a bot" : "every proxy host is switched off";
  }
}
