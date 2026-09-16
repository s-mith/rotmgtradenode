// The server-load watcher: pulls account/servers with a bot's token and
// reports it to the site; a failed pull reports the error instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerUsageWatch } from "../serverUsageWatch";
import type { ServerUsageReport } from "../siteApi";
import type { GameClient } from "../../client/gameClient";
import type { ServerEntry } from "../../realm/api";

function setup(answer: () => ServerEntry[] | null, withBot = true) {
  const clients = new Map<string, GameClient>();
  if (withBot) clients.set("bot", { active: true, isReady: true, token: "tok", proxy: null } as unknown as GameClient);
  const reports: (ServerUsageReport[] | null)[] = [];
  const errors: (string | undefined)[] = [];
  const logs: string[] = [];
  const watch = new ServerUsageWatch({
    clients, log: (l) => logs.push(l),
    api: { reportServerUsage: async (s, e) => { reports.push(s); errors.push(e); return { ok: true }; } },
    fetchServers: async () => answer(),
  });
  return { watch, reports, errors, logs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ServerUsageWatch", () => {
  it("reports every non-admin server's load and logs when the busy set changes", async () => {
    let list: ServerEntry[] = [
      { name: "USEast", dns: "1", usage: 0.3, adminOnly: false },
      { name: "USSouth3", dns: "2", usage: 0, adminOnly: false },
      { name: "Admin", dns: "3", usage: 0.9, adminOnly: true },
    ];
    const { watch, reports, logs } = setup(() => list);
    expect(await watch.refresh()).toBe(true);
    expect(reports).toEqual([[{ name: "USEast", usage: 0.3 }, { name: "USSouth3", usage: 0 }]]);
    expect(logs).toEqual(["server_usage: loaded servers now USEast 30%"]);
    expect(watch.status()).toMatchObject({ lastFetchError: null, skippedNoLender: 0 });
    // Same busy set: reported again, not logged again.
    await watch.refresh();
    expect(reports.length).toBe(2);
    expect(logs.length).toBe(1);
    list = list.map((s) => ({ ...s, usage: 0 }));
    await watch.refresh();
    expect(logs[1]).toBe("server_usage: loaded servers now none");
  });

  it("reports the failure when the fetch yields nothing, and skips without a lender", async () => {
    const { watch, reports, errors } = setup(() => null);
    expect(await watch.refresh()).toBe(false);
    expect(reports).toEqual([null]);
    expect(errors).toEqual(["no list"]);
    expect(watch.status().lastFetchError).toBe("no list");

    const idle = setup(() => [], false);
    expect(await idle.watch.refresh()).toBe(false);
    expect(idle.reports).toEqual([]);
    expect(idle.watch.status().skippedNoLender).toBe(1);
  });

  it("refreshes on its timer once started", async () => {
    const { watch, reports } = setup(() => [{ name: "USEast", dns: "1", usage: 0, adminOnly: false }]);
    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports.length).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reports.length).toBe(2);
    watch.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports.length).toBe(2);
  });
});
