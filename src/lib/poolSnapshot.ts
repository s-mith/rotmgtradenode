// The pool as the site serves it: one snapshot per distinct fleet state, built
// once and handed to every request, with the history that lets a tab holding
// an older revision fetch only what moved. See lib/poolWire.ts for the format
// and the reasons.
//
// Building is one pass over the tracker's instances (~50k) plus, lazily, one
// gzip of ~3 MB; serving is a buffer write. Before this the route serialized
// 13.5 MB of JSON per request, several times a second, and that was ~99% of
// the site's egress and most of its CPU (2026-09-10).
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ITEM_BY_ID } from "./catalog";
import { getDb } from "./db";
import { pyrelay, type PyrelayPool } from "./devauth";
import { enchantName } from "./enchants";
import { projectCatalog } from "./pool";
import { whereLabel, wirePools, type WireBot, type WireStored } from "./poolWire";
import { ownedInstanceIds } from "./vault";

/** One bot's wire entry, serialized once; `items`/`enchants` are the ids its slots reference. */
export interface BotFragment {
  json: string;
  items: string[];
  enchants: number[];
}

interface HistoryEntry {
  rev: string;
  /** Bots whose entry differs from the previous revision's (gone ones included). */
  changed: string[];
  /** The deposit catalog changed too (prices, listings). */
  catalog: boolean;
}
/** Revisions kept for delta answers; a tab further behind than this reloads in full. */
const HISTORY_MAX = 400;

export interface PoolSnapshot {
  rev: string;
  builtAt: number;
  fragments: Map<string, BotFragment>;
  catalogJson: string;
  /** The full message, serialized. Bytes and gzip are made on first use. */
  fullJson: string;
  fullBytes: Buffer | null;
  fullGzip: Buffer | null;
  /** Oldest first; the last entry is this snapshot. */
  history: HistoryEntry[];
  /** Delta bodies served so far, by `since`. */
  deltas: Map<string, { json: string; gzip: Buffer | null }>;
}

// --- pure core ----------------------------------------------------------------

/** Every bot with at least one visible item (not somebody's property, known to the catalog), on its character or in its account's storage, serialized. */
export function buildFragments(pool: PyrelayPool, owned: ReadonlySet<string>): Map<string, BotFragment> {
  const meta = pool.botMeta ?? {};
  const out = new Map<string, BotFragment>();
  const stored = pool.stored ?? {};
  const guids = new Set([...Object.keys(pool.instances ?? {}), ...Object.keys(stored)]);
  for (const botGuid of guids) {
    const wire: WireBot["slots"] = [];
    const kept: WireStored[] = [];
    const items = new Set<string>();
    const enchants = new Set<number>();
    for (const info of Object.values(pool.instances?.[botGuid] ?? {})) {
      if (!info || owned.has(info.instanceId) || !ITEM_BY_ID.has(info.itemId)) continue;
      const ids = info.enchantments ?? [];
      wire.push([info.instanceId, info.itemId, ids]);
      items.add(info.itemId);
      for (const e of ids) enchants.add(e);
    }
    for (const s of stored[botGuid] ?? []) {
      if (!s || owned.has(s.instanceId) || !ITEM_BY_ID.has(s.itemId)) continue;
      const ids = s.enchantments ?? [];
      kept.push([s.instanceId, s.itemId, ids, whereLabel(s.where), wirePools(s.pools)]);
      items.add(s.itemId);
      for (const e of ids) enchants.add(e);
    }
    if (!wire.length && !kept.length) continue;
    const m = meta[botGuid];
    const bot: WireBot = { ign: m?.ign ?? "", server: m?.server ?? "", seasonal: m?.seasonal !== false, slots: wire, ...(kept.length ? { stored: kept } : {}) };
    out.set(botGuid, { json: JSON.stringify(bot), items: [...items], enchants: [...enchants] });
  }
  return out;
}

/** Bots whose entry differs between two fragment maps, gone ones included. */
export function diffFragments(prev: ReadonlyMap<string, BotFragment> | null, next: ReadonlyMap<string, BotFragment>): string[] {
  const changed: string[] = [];
  for (const [g, f] of next) if (prev?.get(g)?.json !== f.json) changed.push(g);
  if (prev) for (const g of prev.keys()) if (!next.has(g)) changed.push(g);
  return changed;
}

/** Content hash: the same pool and catalog give the same revision, restarts included. */
function revOf(fragments: ReadonlyMap<string, BotFragment>, catalogJson: string): string {
  const h = createHash("sha1");
  for (const g of [...fragments.keys()].sort()) h.update(g).update("\x1f").update(fragments.get(g)!.json).update("\x1e");
  h.update("\x1d").update(catalogJson);
  return h.digest("hex").slice(0, 16);
}

function nameDictionaries(fragments: Iterable<BotFragment>): { items: Record<string, string>; enchants: Record<string, string> } {
  const items: Record<string, string> = {};
  const enchants: Record<string, string> = {};
  for (const f of fragments) {
    for (const id of f.items) if (!(id in items)) items[id] = ITEM_BY_ID.get(id)?.name ?? id;
    for (const e of f.enchants) {
      if (e in enchants) continue;
      const n = enchantName(e);
      if (n !== null) enchants[e] = n;
    }
  }
  return { items, enchants };
}

function botsJson(entries: Iterable<[string, BotFragment | null]>): string {
  const parts: string[] = [];
  for (const [g, f] of entries) parts.push(`${JSON.stringify(g)}:${f ? f.json : "null"}`);
  return `{${parts.join(",")}}`;
}

/**
 * The snapshot for `pool`, or `prev` itself when nothing visible changed.
 * Pure: the caller supplies the owned set and the catalog JSON.
 */
export function computeSnapshot(prev: PoolSnapshot | null, pool: PyrelayPool, owned: ReadonlySet<string>, catalogJson: string, now = Date.now()): PoolSnapshot {
  const fragments = buildFragments(pool, owned);
  const changed = diffFragments(prev?.fragments ?? null, fragments);
  const catalogChanged = prev !== null && catalogJson !== prev.catalogJson;
  if (prev && !changed.length && !catalogChanged) return prev;
  const rev = revOf(fragments, catalogJson);
  const names = nameDictionaries(fragments.values());
  const fullJson =
    `{"v":2,"rev":${JSON.stringify(rev)},"full":true,"bots":${botsJson(fragments)},` +
    `"items":${JSON.stringify(names.items)},"enchants":${JSON.stringify(names.enchants)},"catalog":${catalogJson}}`;
  const history = prev ? [...prev.history, { rev, changed, catalog: catalogChanged }] : [{ rev, changed: [], catalog: false }];
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  return { rev, builtAt: now, fragments, catalogJson, fullJson, fullBytes: null, fullGzip: null, history, deltas: new Map() };
}

/** The delta body for a tab at `since`, or null when the history no longer reaches that revision. */
export function poolDelta(snap: PoolSnapshot, since: string): string | null {
  if (since === snap.rev) return `{"v":2,"rev":${JSON.stringify(snap.rev)},"since":${JSON.stringify(since)},"full":false,"bots":{}}`;
  const hit = snap.deltas.get(since);
  if (hit) return hit.json;
  let idx = -1;
  for (let i = snap.history.length - 1; i >= 0; i--) {
    if (snap.history[i].rev === since) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const changed = new Set<string>();
  let catalog = false;
  for (let i = idx + 1; i < snap.history.length; i++) {
    for (const g of snap.history[i].changed) changed.add(g);
    if (snap.history[i].catalog) catalog = true;
  }
  const entries: [string, BotFragment | null][] = [];
  const frags: BotFragment[] = [];
  for (const g of changed) {
    const f = snap.fragments.get(g) ?? null;
    entries.push([g, f]);
    if (f) frags.push(f);
  }
  const names = nameDictionaries(frags);
  const json =
    `{"v":2,"rev":${JSON.stringify(snap.rev)},"since":${JSON.stringify(since)},"full":false,"bots":${botsJson(entries)},` +
    `"items":${JSON.stringify(names.items)},"enchants":${JSON.stringify(names.enchants)}${catalog ? `,"catalog":${snap.catalogJson}` : ""}}`;
  snap.deltas.set(since, { json, gzip: null });
  return json;
}

export function fullBytes(snap: PoolSnapshot): Buffer {
  return (snap.fullBytes ??= Buffer.from(snap.fullJson, "utf8"));
}
export function fullGzip(snap: PoolSnapshot): Buffer {
  return (snap.fullGzip ??= gzipSync(fullBytes(snap), { level: 6 }));
}
export function deltaGzip(snap: PoolSnapshot, since: string, json: string): Buffer {
  const e = snap.deltas.get(since);
  if (e) return (e.gzip ??= gzipSync(json, { level: 6 }));
  return gzipSync(json, { level: 6 });
}

// --- the live snapshot ----------------------------------------------------------

let current: PoolSnapshot | null = null;
let lastPool: PyrelayPool | null = null;
let lastOwnedSig = "";
let lastCheckAt = 0;
let dirty = true;
let inflight: Promise<PoolSnapshot | null> | null = null;
let lastError: string | null = null;
let catalogCache: { at: number; json: string } | null = null;

/** How long a served snapshot is trusted without asking the fleet again, unless a change was announced. */
const RECHECK_MS = 1_000;
/** The catalog's points follow the pricing cache, which has the same lifetime. */
const CATALOG_TTL_MS = 5_000;

/** Something that shows in the pool moved (a tracker change, a claim, a donate): re-check on the next read. */
export function markPoolDirty(): void {
  dirty = true;
}
export function currentPoolSnapshot(): PoolSnapshot | null {
  return current;
}
/** Why the last refresh could not reach the fleet, or null. */
export function poolSnapshotError(): string | null {
  return lastError;
}
/** Test hook. */
export function resetPoolSnapshot(): void {
  current = null;
  lastPool = null;
  lastOwnedSig = "";
  lastCheckAt = 0;
  dirty = true;
  inflight = null;
  lastError = null;
  catalogCache = null;
}

function catalogJsonNow(now: number): string {
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.json;
  const json = JSON.stringify(projectCatalog());
  catalogCache = { at: now, json };
  return json;
}

function ownedSignature(owned: Set<string>): string {
  if (!owned.size) return "0";
  const h = createHash("sha1");
  for (const id of [...owned].sort()) h.update(id).update(",");
  return `${owned.size}:${h.digest("hex").slice(0, 12)}`;
}

/**
 * The current snapshot, rebuilt first if the fleet, the owned set or the
 * catalog moved. Cheap when nothing did: the embedded fleet hands back the
 * same payload object until something changes, so the check is an identity
 * comparison. Concurrent callers share one refresh. Returns the last good
 * snapshot while the fleet is unreachable, null only when there never was one.
 */
export async function refreshPoolSnapshot(opts: { force?: boolean } = {}): Promise<PoolSnapshot | null> {
  if (inflight) return inflight;
  const now = Date.now();
  if (current && !dirty && !opts.force && now - lastCheckAt < RECHECK_MS) return current;
  inflight = (async () => {
    try {
      return await doRefresh(now);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function doRefresh(now: number): Promise<PoolSnapshot | null> {
  lastCheckAt = now;
  dirty = false;
  let pool: PyrelayPool;
  {
    const r = await pyrelay.pool();
    if (!r.ok) {
      lastError = `pyrelay: ${r.error}`;
      return current;
    }
    pool = r.data;
  }
  lastError = null;
  const owned = ownedInstanceIds(getDb());
  const ownedSig = ownedSignature(owned);
  const catalogJson = catalogJsonNow(now);
  if (current && pool === lastPool && ownedSig === lastOwnedSig && catalogJson === current.catalogJson) return current;
  lastPool = pool;
  lastOwnedSig = ownedSig;
  current = computeSnapshot(current, pool, owned, catalogJson, now);
  return current;
}

