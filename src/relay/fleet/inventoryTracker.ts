// Per-bot inventory: what each bot holds, per physical item, with sticky
// instance ids. Persisted to <dataDir>/inventory_state.json with coalesced
// writes. Port of pyrelay's inventory_tracker (same file format).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_CAPACITY = 8;
const SAVE_INTERVAL_MS = Number(process.env.INVENTORY_SAVE_INTERVAL_SECONDS ?? 5) * 1000;
const VERIFY_FLUSH_MS = 60_000;
const TRANSFER_TTL_MS = 300_000;

export interface Instance {
  instanceId: string;
  itemId: string;
  enchantments: number[];
  /** Epoch seconds, matching the Python file format. */
  capturedAt: number;
}
export type Slots = Record<number, Instance>;
export type SlotInput = Record<number, { itemId: string; enchantments: number[] }>;

interface FileShape {
  items: Record<string, Record<string, number>>;
  capacities: Record<string, number>;
  instances: Record<string, Record<string, { instance_id: string; item_id: string; enchantments: number[]; captured_at: number }>>;
  igns: Record<string, string>;
  verified: Record<string, number>;
  saved_at: number;
}

export class InventoryTracker {
  private items = new Map<string, Record<string, number>>();
  private instances = new Map<string, Slots>();
  private capacity = new Map<string, number>();
  private igns = new Map<string, string>();
  private verified = new Map<string, number>();
  /** instance id -> the bot holding it; kept in step with `instances`. */
  private holder = new Map<string, string>();
  /** Instances in flight to a bot from a consolidation: keyed by the receiving bot. */
  private pendingTransfer = new Map<string, { inst: Instance; at: number }[]>();
  private rev = 0;
  /** Fired after any change that bumps the revision. */
  onChange: (() => void) | null = null;
  private dirty = false;
  private lastSaveAt = 0;
  private lastVerifyFlush = 0;
  private flusher: ReturnType<typeof setInterval> | null = null;
  readonly previous: { savedAt: number | null; verified: Map<string, number>; known: Set<string> };

  constructor(private readonly filePath: string) {
    this.previous = { savedAt: null, verified: new Map(), known: new Set() };
    this.load();
  }

  static at(dataDir: string): InventoryTracker {
    return new InventoryTracker(path.join(dataDir, "inventory_state.json"));
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    let raw: Partial<FileShape> & Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (e) {
      console.log(`inventory_tracker: failed to load ${this.filePath}: ${String(e)}`);
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const hasKeys = "items" in raw || "capacities" in raw || "instances" in raw || "igns" in raw;
    const items = (hasKeys ? raw.items : (raw as Record<string, Record<string, number>>)) ?? {};
    for (const [guid, inv] of Object.entries(items)) {
      if (!inv || typeof inv !== "object") continue;
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(inv)) if (typeof v === "number" && v > 0) cleaned[k] = v;
      if (Object.keys(cleaned).length) this.items.set(guid, cleaned);
    }
    for (const [guid, cap] of Object.entries(raw.capacities ?? {})) if (typeof cap === "number" && cap > 0) this.capacity.set(guid, cap);
    for (const [guid, slots] of Object.entries(raw.instances ?? {})) {
      const out: Slots = {};
      for (const [s, info] of Object.entries(slots ?? {})) {
        const slot = Number(s);
        if (!Number.isInteger(slot) || !info || typeof info.instance_id !== "string" || typeof info.item_id !== "string") continue;
        const entry: Instance = {
          instanceId: info.instance_id,
          itemId: info.item_id,
          enchantments: (info.enchantments ?? []).filter((e) => Number.isInteger(e)),
          capturedAt: typeof info.captured_at === "number" ? info.captured_at : 0,
        };
        out[slot] = entry;
      }
      if (Object.keys(out).length) {
        this.instances.set(guid, out);
        for (const i of Object.values(out)) this.holder.set(i.instanceId, guid);
      }
    }
    for (const [guid, ign] of Object.entries(raw.igns ?? {})) if (typeof ign === "string" && ign.trim()) this.igns.set(guid, ign);
    for (const [guid, ts] of Object.entries(raw.verified ?? {})) if (typeof ts === "number") this.verified.set(guid, ts);
    this.previous.savedAt = typeof raw.saved_at === "number" ? raw.saved_at : null;
    this.previous.verified = new Map(this.verified);
    this.previous.known = new Set([...this.items.keys(), ...this.instances.keys(), ...this.capacity.keys()]);
    console.log(`inventory_tracker: loaded ${this.items.size} bot(s), ${[...this.instances.values()].reduce((a, s) => a + Object.keys(s).length, 0)} instance(s), ${this.igns.size} ign(s)`);
  }

  private save(): void {
    const out: FileShape = {
      items: Object.fromEntries(this.items),
      capacities: Object.fromEntries(this.capacity),
      instances: Object.fromEntries(
        [...this.instances].map(([guid, slots]) => [
          guid,
          Object.fromEntries(
            Object.entries(slots).map(([s, i]) => [
              s,
              { instance_id: i.instanceId, item_id: i.itemId, enchantments: i.enchantments, captured_at: i.capturedAt },
            ]),
          ),
        ]),
      ),
      igns: Object.fromEntries(this.igns),
      verified: Object.fromEntries(this.verified),
      saved_at: Date.now() / 1000,
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.log(`inventory_tracker: failed to write ${this.filePath}: ${String(e)}`);
    }
  }

  private requestSave(force = false): void {
    this.dirty = true;
    if (!this.flusher) {
      this.flusher = setInterval(() => this.flush(), SAVE_INTERVAL_MS);
      this.flusher.unref();
    }
    const now = Date.now();
    if (force || now - this.lastSaveAt >= SAVE_INTERVAL_MS) {
      this.lastSaveAt = now;
      this.dirty = false;
      this.save();
    }
  }

  flush(): void {
    if (!this.dirty) return;
    this.requestSave(true);
  }

  close(): void {
    this.flush();
    if (this.flusher) clearInterval(this.flusher);
    this.flusher = null;
  }

  revision(): number {
    return this.rev;
  }

  /**
   * A consolidation trade moved `items` from one bot to another. The
   * receiving bot's next refresh will show them as new slots; keep their
   * instance ids so a per-instance withdraw picked before the move still
   * names the same physical item, now on the other bot.
   */
  noteTransfer(fromGuid: string, toGuid: string, items: { itemId: string; qty: number }[]): void {
    if (!fromGuid || !toGuid || fromGuid === toGuid) return;
    const want: Record<string, number> = {};
    for (const it of items) if (it.qty > 0) want[it.itemId] = (want[it.itemId] ?? 0) + it.qty;
    const from = Object.values(this.instances.get(fromGuid) ?? {});
    const list = this.pendingTransfer.get(toGuid) ?? [];
    const now = Date.now();
    for (const [itemId, qty] of Object.entries(want)) {
      // The giver offers its least-enchanted copies first.
      const cands = from.filter((i) => i.itemId === itemId).sort((a, b) => a.enchantments.length - b.enchantments.length);
      for (const inst of cands.slice(0, qty)) list.push({ inst: { ...inst, enchantments: [...inst.enchantments] }, at: now });
    }
    if (list.length) this.pendingTransfer.set(toGuid, list);
  }

  /** Which bot the tracker last saw holding this instance, if any. */
  holderOf(instanceId: string): string | undefined {
    return this.holder.get(instanceId);
  }

  /** Like noteTransfer, but for exactly these instances (a vault move names its items). */
  noteTransferInstances(fromGuid: string, toGuid: string, instanceIds: string[]): void {
    if (!fromGuid || !toGuid || fromGuid === toGuid) return;
    const want = new Set(instanceIds);
    const list = this.pendingTransfer.get(toGuid) ?? [];
    const now = Date.now();
    for (const inst of Object.values(this.instances.get(fromGuid) ?? {})) {
      if (want.has(inst.instanceId)) list.push({ inst: { ...inst, enchantments: [...inst.enchantments] }, at: now });
    }
    if (list.length) this.pendingTransfer.set(toGuid, list);
  }

  /** An instance on its way back to `botGuid` from the account's own storage: the next refresh keeps its id and enchants. */
  expectArrival(botGuid: string, inst: Instance): void {
    const list = this.pendingTransfer.get(botGuid) ?? [];
    list.push({ inst: { ...inst, enchantments: [...inst.enchantments] }, at: Date.now() });
    this.pendingTransfer.set(botGuid, list);
  }

  /** A move to `toGuid` did not happen: forget the instances promised to it. */
  cancelTransfer(toGuid: string, instanceIds?: string[]): void {
    const notes = this.pendingTransfer.get(toGuid);
    if (!notes) return;
    const drop = instanceIds ? new Set(instanceIds) : null;
    const left = drop ? notes.filter((n) => !drop.has(n.inst.instanceId)) : [];
    if (left.length) this.pendingTransfer.set(toGuid, left);
    else this.pendingTransfer.delete(toGuid);
  }

  private consumeTransfer(botGuid: string, itemId: string, enchantments: number[]): Instance | undefined {
    const notes = this.pendingTransfer.get(botGuid);
    if (!notes) return undefined;
    const now = Date.now();
    const live = notes.filter((n) => now - n.at <= TRANSFER_TTL_MS);
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    let idx = live.findIndex((n) => n.inst.itemId === itemId && same(n.inst.enchantments, enchantments));
    if (idx === -1) idx = live.findIndex((n) => n.inst.itemId === itemId);
    const hit = idx === -1 ? undefined : live.splice(idx, 1)[0].inst;
    if (live.length) this.pendingTransfer.set(botGuid, live);
    else this.pendingTransfer.delete(botGuid);
    return hit;
  }

  /** Slot-aware update; returns true when persisted state changed. */
  updateFromSlots(botGuid: string, slots: SlotInput, capacity?: number): boolean {
    const now = Date.now() / 1000;
    const prevSlots = this.instances.get(botGuid) ?? {};
    const next: Slots = {};
    const counts: Record<string, number> = {};
    for (const [s, { itemId, enchantments }] of Object.entries(slots)) {
      const slot = Number(s);
      counts[itemId] = (counts[itemId] ?? 0) + 1;
      const prev = prevSlots[slot];
      if (prev && prev.itemId === itemId) {
        next[slot] = { instanceId: prev.instanceId, itemId, enchantments: [...enchantments], capturedAt: prev.capturedAt ?? now };
      } else {
        const moved = this.consumeTransfer(botGuid, itemId, enchantments);
        next[slot] = { instanceId: moved?.instanceId ?? randomUUID().replace(/-/g, ""), itemId, enchantments: [...enchantments], capturedAt: moved?.capturedAt ?? now };
      }
    }
    const prevItems = this.items.get(botGuid);
    const prevCap = this.capacity.get(botGuid);
    const newCap = capacity === undefined ? prevCap : capacity;
    this.verified.set(botGuid, now);
    if (sameCounts(prevItems, counts) && prevCap === newCap && sameSlots(prevSlots, next)) {
      const mono = Date.now();
      if (mono - this.lastVerifyFlush >= VERIFY_FLUSH_MS) {
        this.lastVerifyFlush = mono;
        this.requestSave();
      }
      return false;
    }
    this.items.set(botGuid, counts);
    for (const i of Object.values(prevSlots)) if (this.holder.get(i.instanceId) === botGuid) this.holder.delete(i.instanceId);
    for (const i of Object.values(next)) this.holder.set(i.instanceId, botGuid);
    this.instances.set(botGuid, next);
    if (newCap !== undefined) this.capacity.set(botGuid, newCap);
    this.rev++;
    this.onChange?.();
    this.lastVerifyFlush = Date.now();
    this.requestSave();
    return true;
  }

  removeBot(botGuid: string): void {
    for (const i of Object.values(this.instances.get(botGuid) ?? {})) if (this.holder.get(i.instanceId) === botGuid) this.holder.delete(i.instanceId);
    const changed = this.items.delete(botGuid) || this.capacity.delete(botGuid) || this.instances.delete(botGuid) || this.igns.delete(botGuid);
    this.pendingTransfer.delete(botGuid);
    if (changed) {
      this.rev++;
      this.requestSave(true);
    }
  }

  recordIgn(botGuid: string, ign: string): void {
    ign = (ign ?? "").trim();
    if (!botGuid || !ign || this.igns.get(botGuid) === ign) return;
    this.igns.set(botGuid, ign);
    this.rev++;
    this.requestSave();
  }
  ignFor(botGuid: string): string {
    return this.igns.get(botGuid) ?? "";
  }
  ignsSnapshot(): Record<string, string> {
    return Object.fromEntries(this.igns);
  }

  itemsFor(botGuid: string): Record<string, number> {
    return { ...(this.items.get(botGuid) ?? {}) };
  }
  /** Items this bot holds per the tracker; 0 when it has never been seen. */
  heldCount(botGuid: string): number {
    let n = 0;
    for (const q of Object.values(this.items.get(botGuid) ?? {})) n += q;
    return n;
  }
  instancesFor(botGuid: string): Slots {
    const src = this.instances.get(botGuid) ?? {};
    const out: Slots = {};
    for (const [s, i] of Object.entries(src)) out[Number(s)] = { ...i, enchantments: [...i.enchantments] };
    return out;
  }
  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [g, inv] of this.items) out[g] = { ...inv };
    return out;
  }
  instancesSnapshot(): Record<string, Slots> {
    const out: Record<string, Slots> = {};
    for (const g of this.instances.keys()) out[g] = this.instancesFor(g);
    return out;
  }
  /** Per-bot trade-slot capacity: 8, or 16 once a backpack was observed on
   *  that bot. Strictly per bot — there is no pool-wide override; a fleet
   *  where only some characters carry backpacks is the normal case. */
  capacities(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [g, cap] of this.capacity) out[g] = cap;
    return out;
  }
  // Read-only views of the live maps, for the callers that walk the whole
  // fleet every few seconds (routing, the served pool, the potion planner).
  // The copies above cost a deep copy of ~50k instances per call, which at a
  // 17k-account roster was most of the process's allocation. Per-bot records
  // are replaced, never edited in place, so a view stays consistent for as
  // long as a caller holds it; callers must not mutate what they get.
  itemsView(): ReadonlyMap<string, Readonly<Record<string, number>>> {
    return this.items;
  }
  instancesView(): ReadonlyMap<string, Readonly<Slots>> {
    return this.instances;
  }
  capacityView(): ReadonlyMap<string, number> {
    return this.capacity;
  }
  ignsView(): ReadonlyMap<string, string> {
    return this.igns;
  }
  capacityFor(botGuid: string): number {
    return this.capacity.get(botGuid) ?? DEFAULT_CAPACITY;
  }
  /** Set a bot's slot count from an authoritative source that saw no inventory (char/list's BackpackSlots). */
  noteCapacity(botGuid: string, capacity: number): boolean {
    return this.noteCapacities({ [botGuid]: capacity }) > 0;
  }
  /**
   * Many bots' slot counts at once: ONE revision bump, ONE change
   * notification, ONE save. The change hook makes the site rebuild its whole
   * pool view; firing it per bot over a 16k-account roster ran the process
   * out of heap on 2026-09-07. Returns how many bots changed.
   */
  noteCapacities(caps: Record<string, number>): number {
    let changed = 0;
    for (const [botGuid, capacity] of Object.entries(caps)) {
      if (this.capacity.get(botGuid) === capacity) continue;
      this.capacity.set(botGuid, capacity);
      changed++;
    }
    if (!changed) return 0;
    this.rev++;
    this.onChange?.();
    this.requestSave();
    return changed;
  }
  verifiedAt(botGuid: string): number | undefined {
    return this.verified.get(botGuid);
  }
  onlineView(guids: string[]): Record<string, { items: Record<string, number>; capacity: number; ign: string; verifiedAt: number | null }> {
    const out: Record<string, { items: Record<string, number>; capacity: number; ign: string; verifiedAt: number | null }> = {};
    const caps = this.capacities();
    for (const g of guids) {
      out[g] = { items: this.itemsFor(g), capacity: caps[g] ?? DEFAULT_CAPACITY, ign: this.igns.get(g) ?? "", verifiedAt: this.verified.get(g) ?? null };
    }
    return out;
  }
}

function sameCounts(a: Record<string, number> | undefined, b: Record<string, number>): boolean {
  if (!a) return Object.keys(b).length === 0;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
function sameSlots(a: Slots, b: Slots): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[Number(k)];
    const y = b[Number(k)];
    if (!y || x.instanceId !== y.instanceId || x.itemId !== y.itemId) return false;
    if (x.enchantments.length !== y.enchantments.length || x.enchantments.some((e, i) => e !== y.enchantments[i])) return false;
  }
  return true;
}
