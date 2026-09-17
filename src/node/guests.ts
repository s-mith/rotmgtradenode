// Shared vaults (design doc §6.5): the node's side. Grants live on the hub;
// this mirrors them into the node's per-user vault tables (a guest is a
// local user with a slot quota per half), publishes each guest's vault to
// the hub, and executes the requests guests queue there: deposits and
// withdraws through the normal queue, offers through the swap coordinator.
import type Database from "better-sqlite3";
import type { GrantWire, GuestRequestResult, GuestRequestWire, PublishVaultsRequest } from "../shared/hubWire";
import type { HubClient } from "./hub";
import type { SwapCoordinator } from "./swaps";
import type { PyrelayPool } from "../lib/devauth";
import { ITEM_BY_ID } from "../lib/catalog";
import { createDepositRequest } from "../lib/depositRequest";
import { parseWantInput, wantFromWire } from "../lib/offers";
import { userForIgn } from "../lib/users";
import { vaultCount, vaultHalf, vaultItems } from "../lib/vault";
import { createVaultWithdraw } from "../lib/vaultWithdraw";
import type { OfferWire } from "../shared/hubWire";

export const GUEST_POLL_MS = Number(process.env.GUEST_POLL_SECONDS ?? 15) * 1000;
export const GRANT_POLL_MS = Number(process.env.GRANT_POLL_SECONDS ?? 60) * 1000;

export interface GuestsOptions {
  db: () => Database.Database;
  hub: HubClient;
  swaps: SwapCoordinator;
  pool: () => PyrelayPool | null;
  log: (s: string) => void;
  now?: () => number;
}

/** A grant as mirrored locally: the hub's grant plus the local user it maps to. */
export interface LocalGuest {
  grantId: number;
  hubUserId: number;
  localUserId: number;
  ign: string;
  displayName: string;
  slotsSeasonal: number;
  slotsNonseasonal: number;
  role: GrantWire["role"];
  trade: boolean;
  paused: boolean;
  usedSeasonal: number;
  usedNonseasonal: number;
}

export class GuestCoordinator {
  private grants: GrantWire[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private grantTimer: ReturnType<typeof setInterval> | null = null;
  private lastGrantsAt: number | null = null;
  private lastRequestsAt: number | null = null;
  private lastPublishHash = "";
  private lastError: string | null = null;
  private recent: { id: number; kind: string; guest: string; ok: boolean; detail: string; at: number }[] = [];
  private readonly now: () => number;
  constructor(private readonly o: GuestsOptions) {
    this.now = o.now ?? Date.now;
    o.db().exec(`CREATE TABLE IF NOT EXISTS hub_guests (
      grant_id INTEGER PRIMARY KEY,
      hub_user_id INTEGER NOT NULL,
      local_user_id INTEGER NOT NULL,
      ign TEXT NOT NULL,
      display_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  // --- grants ---------------------------------------------------------------------

  /** Mirror the hub's grants: a local user per guest IGN, with the quota as their vault caps. */
  async refreshGrants(): Promise<boolean> {
    if (!this.o.hub.linked) return false;
    const r = await this.o.hub.signed<{ grants: GrantWire[] }>("GET", "/api/v1/grants");
    this.lastGrantsAt = this.now();
    if (!r.ok) {
      this.lastError = `grants: ${r.error}`;
      return false;
    }
    this.lastError = null;
    this.grants = r.data.grants;
    const db = this.o.db();
    const seen = new Set<number>();
    for (const g of r.data.grants) {
      seen.add(g.id);
      const localUserId = userForIgn(db, g.ign, g.ign.toLowerCase());
      db.prepare("INSERT INTO hub_guests (grant_id, hub_user_id, local_user_id, ign, display_name, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET hub_user_id = excluded.hub_user_id, local_user_id = excluded.local_user_id, ign = excluded.ign, display_name = excluded.display_name, updated_at = excluded.updated_at")
        .run(g.id, g.guest.userId, localUserId, g.ign, g.guest.displayName, this.now());
      // The quota is the half's cap. Lowering never evicts: rows stay, new
      // deposits and incoming trades are refused until under (vault.ts room checks).
      db.prepare("UPDATE vault_halves SET slots = ? WHERE user_id = ? AND seasonal = 1").run(g.slotsSeasonal, localUserId);
      db.prepare("UPDATE vault_halves SET slots = ? WHERE user_id = ? AND seasonal = 0").run(g.slotsNonseasonal, localUserId);
      db.prepare("UPDATE users SET vault_slots = ? WHERE id = ?").run(g.slotsSeasonal + g.slotsNonseasonal, localUserId);
    }
    // Revoked grants keep their items (never evict) but lose their quota.
    for (const row of db.prepare("SELECT grant_id, local_user_id, ign FROM hub_guests").all() as { grant_id: number; local_user_id: number; ign: string }[]) {
      if (seen.has(row.grant_id)) continue;
      db.prepare("UPDATE vault_halves SET slots = 0 WHERE user_id = ?").run(row.local_user_id);
      db.prepare("DELETE FROM hub_guests WHERE grant_id = ?").run(row.grant_id);
      this.o.log(`guests: grant for ${row.ign} revoked; quota set to 0 (items stay until withdrawn)`);
    }
    return true;
  }

  guests(): LocalGuest[] {
    const db = this.o.db();
    return (db.prepare("SELECT grant_id, hub_user_id, local_user_id, ign, display_name FROM hub_guests").all() as { grant_id: number; hub_user_id: number; local_user_id: number; ign: string; display_name: string }[])
      .map((row) => {
        const g = this.grants.find((x) => x.id === row.grant_id);
        return {
          grantId: row.grant_id, hubUserId: row.hub_user_id, localUserId: row.local_user_id, ign: row.ign, displayName: row.display_name,
          slotsSeasonal: g?.slotsSeasonal ?? 0, slotsNonseasonal: g?.slotsNonseasonal ?? 0, role: g?.role ?? "deposit", trade: g?.trade ?? false, paused: g?.paused ?? false,
          usedSeasonal: vaultCount(db, row.local_user_id, true), usedNonseasonal: vaultCount(db, row.local_user_id, false),
        };
      });
  }
  private guestByHubUser(hubUserId: number): LocalGuest | undefined {
    return this.guests().find((g) => g.hubUserId === hubUserId);
  }

  // --- publish -----------------------------------------------------------------------

  /** Each guest's vault as the hub should show it. */
  publishPayload(): PublishVaultsRequest {
    const db = this.o.db();
    const pool = this.o.pool();
    const online = new Map<string, boolean>();
    const enchants = new Map<string, number[]>();
    if (pool) {
      for (const [g, meta] of Object.entries(pool.botMeta ?? {})) online.set(g, !!meta.online);
      for (const slots of Object.values(pool.instances ?? {})) for (const i of Object.values(slots)) enchants.set(i.instanceId, i.enchantments ?? []);
    }
    const guests = this.guests().map((g) => {
      const items = vaultItems(db, g.localUserId);
      const half = (seasonal: boolean) => ({
        slots: seasonal ? g.slotsSeasonal : g.slotsNonseasonal,
        used: items.filter((i) => i.seasonal === seasonal).length,
        items: items.filter((i) => i.seasonal === seasonal).map((i) => ({
          ref: i.instanceId, itemId: i.itemId, name: ITEM_BY_ID.get(i.itemId)?.name ?? i.itemId, enchants: enchants.get(i.instanceId) ?? null,
          count: enchants.get(i.instanceId)?.length ?? i.enchants, online: i.botGuid ? online.get(i.botGuid) ?? false : false,
        })),
      });
      return { userId: g.hubUserId, seasonal: half(true), nonseasonal: half(false) };
    });
    return { guests, at: this.now() };
  }

  async publish(force = false): Promise<boolean> {
    if (!this.o.hub.linked) return false;
    const payload = this.publishPayload();
    if (!payload.guests.length && !force) return false;
    const hash = JSON.stringify(payload.guests);
    if (!force && hash === this.lastPublishHash) return false;
    const r = await this.o.hub.signed("POST", "/api/v1/vaults/publish", payload);
    if (!r.ok) {
      this.lastError = `publish: ${r.error}`;
      return false;
    }
    this.lastPublishHash = hash;
    return true;
  }

  // --- guest requests ------------------------------------------------------------------

  async pollRequests(): Promise<number> {
    if (!this.o.hub.linked) return 0;
    const r = await this.o.hub.signed<{ requests: GuestRequestWire[] }>("GET", "/api/v1/guest-requests");
    this.lastRequestsAt = this.now();
    if (!r.ok) {
      this.lastError = `requests: ${r.error}`;
      return 0;
    }
    let n = 0;
    for (const req of r.data.requests) {
      const result = await this.execute(req).catch((e): GuestRequestResult => ({ ok: false, error: String((e as Error).message ?? e) }));
      const rr = await this.o.hub.signed("POST", `/api/v1/guest-requests/${req.id}/result`, result);
      if (!rr.ok) this.o.log(`guests: result for request #${req.id} not delivered: ${rr.error}`);
      this.recent.unshift({ id: req.id, kind: req.kind, guest: req.guest.displayName, ok: result.ok, detail: result.error ?? result.detail ?? "", at: this.now() });
      if (this.recent.length > 30) this.recent.length = 30;
      this.o.log(`guests: ${req.guest.displayName} ${req.kind} #${req.id} -> ${result.ok ? "ok" : `failed: ${result.error}`}`);
      n++;
    }
    if (n) await this.publish(true);
    return n;
  }

  /** One guest request, against the local queue or the swap coordinator. */
  async execute(req: GuestRequestWire): Promise<GuestRequestResult> {
    const guest = this.guestByHubUser(req.guest.userId);
    if (!guest) return { ok: false, error: "no grant for this guest on this node" };
    if (guest.paused) return { ok: false, error: "the owner paused this guest" };
    const db = this.o.db();
    const forUser = { localUserId: guest.localUserId, hubUserId: guest.hubUserId };
    switch (req.kind) {
      case "deposit": {
        if (!req.server || !req.count) return { ok: false, error: "deposit needs a server and a count" };
        const half = vaultHalf(db, guest.localUserId, req.seasonal);
        const room = half.slots - vaultCount(db, guest.localUserId, req.seasonal);
        if (req.count > room) return { ok: false, error: `only ${room} slot(s) free in that half` };
        const r = await createDepositRequest(db, { ign: guest.ign, ignLower: guest.ign.toLowerCase(), server: req.server, slots: req.count, seasonal: req.seasonal ? 1 : 0, vaultUserId: guest.localUserId });
        return r.ok ? { ok: true, requestId: r.requestId, detail: `deposit queued on ${req.server}; /tell the bot to trade` } : { ok: false, error: r.error };
      }
      case "withdraw": {
        if (!req.server || !req.refs?.length) return { ok: false, error: "withdraw needs a server and items" };
        if (guest.role === "deposit") return { ok: false, error: "this grant is deposit-only" };
        const pool = this.o.pool();
        if (!pool) return { ok: false, error: "the fleet is not reachable" };
        const r = createVaultWithdraw(db, pool, { userId: guest.localUserId, ign: guest.ign, server: req.server, instanceIds: req.refs });
        return r.ok ? { ok: true, requestId: r.requestIds[0], detail: `${r.requestIds.length} withdraw row(s) queued on ${req.server}` } : { ok: false, error: r.error };
      }
      case "offer-create": {
        if (!guest.trade) return { ok: false, error: "this grant does not allow trading" };
        if (!req.refs?.length || !req.want?.length || !req.server) return { ok: false, error: "an offer needs items, wants and a server" };
        const want = parseWantInput(req.want);
        if (!want.ok) return { ok: false, error: want.error };
        const r = await this.o.swaps.createOffer({ instanceIds: req.refs, want: want.want, server: req.server, forUser });
        return r.ok ? { ok: true, offerId: r.offer.id } : { ok: false, error: r.error };
      }
      case "offer-accept": {
        if (!guest.trade) return { ok: false, error: "this grant does not allow trading" };
        if (!req.offerId) return { ok: false, error: "which offer?" };
        const b = await this.o.swaps.browse();
        if (!b.ok) return { ok: false, error: b.error };
        const offer = b.offers.find((o) => o.id === req.offerId);
        if (!offer) return { ok: false, error: "that offer is no longer open" };
        const r = await this.o.swaps.acceptOffer(offer as OfferWire, forUser);
        return r.ok ? { ok: true, offerId: offer.id, detail: `meeting #${r.rendezvous.id} on ${r.rendezvous.server}` } : { ok: false, error: r.error };
      }
      case "offer-cancel": {
        if (!req.offerId) return { ok: false, error: "which offer?" };
        const r = await this.o.swaps.cancelOffer(req.offerId);
        return r.ok ? { ok: true, offerId: req.offerId } : { ok: false, error: r.error };
      }
      default:
        return { ok: false, error: `unknown request kind ${String((req as { kind: string }).kind)}` };
    }
  }

  // --- lifecycle ---------------------------------------------------------------------------

  async tick(): Promise<void> {
    await this.pollRequests();
    await this.publish();
  }
  start(): void {
    if (this.timer) return;
    void this.refreshGrants().then(() => this.tick());
    this.timer = setInterval(() => void this.tick(), GUEST_POLL_MS);
    this.timer.unref?.();
    this.grantTimer = setInterval(() => void this.refreshGrants(), GRANT_POLL_MS);
    this.grantTimer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.grantTimer) clearInterval(this.grantTimer);
    this.timer = null;
    this.grantTimer = null;
  }
  status() {
    return { linked: this.o.hub.linked, lastGrantsAt: this.lastGrantsAt, lastRequestsAt: this.lastRequestsAt, lastError: this.lastError, guests: this.guests(), recent: this.recent };
  }

  // --- owner actions (through the hub) -------------------------------------------------------

  async createGrant(input: { email: string; ign: string; slotsSeasonal: number; slotsNonseasonal: number; role: GrantWire["role"]; trade: boolean }): Promise<{ ok: true; grant: GrantWire } | { ok: false; status: number; error: string }> {
    const r = await this.o.hub.signed<{ grant: GrantWire }>("POST", "/api/v1/grants", input);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    await this.refreshGrants();
    await this.publish(true);
    return { ok: true, grant: r.data.grant };
  }
  async updateGrant(id: number, patch: Partial<{ ign: string; slotsSeasonal: number; slotsNonseasonal: number; role: GrantWire["role"]; trade: boolean; paused: boolean }>): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const r = await this.o.hub.signed("PUT", `/api/v1/grants/${id}`, patch);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    await this.refreshGrants();
    await this.publish(true);
    return { ok: true };
  }
  async deleteGrant(id: number): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const r = await this.o.hub.signed("DELETE", `/api/v1/grants/${id}`, {});
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    await this.refreshGrants();
    return { ok: true };
  }
}

/** Want lines as a guest typed them on the hub, into what parseWantInput expects. */
export function wantInputFromWire(w: GuestRequestWire["want"]): unknown {
  return w ? wantFromWire(w) : [];
}
