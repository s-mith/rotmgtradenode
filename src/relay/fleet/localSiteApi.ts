// The site's queue, called directly. Same interface as the HTTP client, so
// the dispatcher doesn't know which one it has; this one skips the network,
// the signatures, and the nonce table entirely.
import type Database from "better-sqlite3";
import { presence } from "../../lib/fleetPresence";
import { serverUsage } from "../../lib/serverUsage";
import * as queue from "../../lib/queue";
import { listVaultsForFleet, noteVaultMoved } from "../../lib/vault";
import { ApiStats, type ApiResult, type Assignment, type FleetVault, type ItemQty, type PendingDeposit, type PendingWithdraw, type PoolRoom, type ReceivedInstance, type ServerUsageReport, type SiteApi, type SwapResult } from "./siteApi";

export class LocalSiteApi implements SiteApi {
  readonly timeoutMs = 1000;
  readonly stats = new ApiStats();
  constructor(private readonly db: () => Database.Database) {}

  private run<T extends Record<string, unknown>>(name: string, fn: () => T): ApiResult<T> {
    const started = Date.now();
    try {
      const value = fn();
      this.stats.record(name, Date.now() - started, true);
      return { ok: true, ...value };
    } catch (e) {
      this.stats.record(name, Date.now() - started, false);
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof queue.QueueError)) console.error(`[queue] ${name} raised:`, e);
      return { ok: false, error: msg, status: e instanceof queue.QueueError ? 400 : 500 };
    }
  }

  async heartbeat(p: { botGuid: string; alias: string; ign: string; server: string; freeSlots: number; status: "idle" | "busy" | "offline"; seasonal: boolean }): Promise<ApiResult> {
    presence.report(p);
    return { ok: true };
  }
  async claimDeposit(botGuid: string, freeSlots?: number, preferRequestId?: number | null): Promise<ApiResult<{ assignment: Assignment | null }>> {
    return this.run("claim-deposit", () => ({ assignment: queue.claimDeposit(this.db(), botGuid, freeSlots, preferRequestId) }));
  }
  async claimWithdraw(botGuid: string, inventory: ItemQty[], instanceIds: string[]): Promise<ApiResult<{ assignment: Assignment | null }>> {
    return this.run("claim-withdraw", () => ({ assignment: queue.claimWithdraw(this.db(), botGuid, inventory, instanceIds) }));
  }
  async fulfillDeposit(botGuid: string, requestId: number, items: ItemQty[], units?: { itemId: string; enchants: number }[] | null, instances?: ReceivedInstance[] | null): Promise<ApiResult> {
    return this.run("fulfill", () => ({ ...queue.fulfillDeposit(this.db(), botGuid, requestId, items, units?.length ? units : null, instances?.length ? instances : null) }));
  }
  async fulfillWithdraw(botGuid: string, requestId: number, items: ItemQty[], instanceIds: string[] = []): Promise<ApiResult> {
    return this.run("withdraw-fulfill", () => ({ ...queue.fulfillWithdraw(this.db(), botGuid, requestId, items, instanceIds) }));
  }
  async registerPool(readyCount: number, room?: PoolRoom): Promise<ApiResult> {
    presence.setReadyCount(readyCount);
    if (room) presence.setPoolRoom(room);
    return { ok: true };
  }
  async reportServerUsage(servers: ServerUsageReport[] | null, error?: string): Promise<ApiResult> {
    if (servers) serverUsage.set(servers);
    else serverUsage.noteError(error ?? "fetch failed");
    return { ok: true };
  }
  async unclaim(botGuid: string, requestId: number, kind: "deposit" | "withdraw"): Promise<ApiResult<{ unclaimed?: boolean }>> {
    return this.run("unclaim", () => ({ unclaimed: queue.unclaim(this.db(), botGuid, requestId, kind) }));
  }
  async giveUp(botGuid: string, requestId: number, kind: "deposit" | "withdraw"): Promise<ApiResult<{ cancelled?: boolean }>> {
    return this.run("give-up", () => ({ cancelled: queue.giveUp(this.db(), botGuid, requestId, kind) }));
  }
  async listPending(): Promise<ApiResult<{ withdraws: PendingWithdraw[]; deposits: PendingDeposit[]; vaultBots: string[] }>> {
    return this.run("list-pending", () => queue.listPending(this.db()));
  }
  async listVaults(): Promise<ApiResult<{ vaults: FleetVault[] }>> {
    return this.run("list-vaults", () => ({ vaults: listVaultsForFleet(this.db()) }));
  }
  async vaultMoved(instanceIds: string[], botGuid: string): Promise<ApiResult<{ moved?: number }>> {
    return this.run("vault-moved", () => ({ moved: noteVaultMoved(this.db(), instanceIds, botGuid) }));
  }
  async reportSwap(botGuid: string, requestId: number, result: SwapResult): Promise<ApiResult> {
    return this.run("swap-report", () => ({ ...queue.reportSwap(this.db(), botGuid, requestId, result) }));
  }
  async swapReceived(_botGuid: string, requestId: number, vaultUserId: number, instances: ReceivedInstance[]): Promise<ApiResult> {
    return this.run("swap-received", () => ({ attached: queue.attachSwapReceived(this.db(), requestId, vaultUserId, instances) }));
  }
}
