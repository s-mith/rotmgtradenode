// The load gate: a fresh reading over the limit closes a server to trades;
// a stale or missing one leaves only the operator's toggles in force.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { blockMessage, depositBlock, getAllServerControls, setServerControl, withdrawBlock } from "../serverControls";
import { serverUsage, USAGE_FRESH_MS } from "../serverUsage";

let db: Database.Database;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  db = openDatabase(":memory:");
  serverUsage.reset();
});
afterEach(() => {
  db.close();
  serverUsage.reset();
  vi.useRealTimers();
});

describe("serverUsage gate", () => {
  it("closes a loaded server to both kinds and keeps an empty one open", () => {
    serverUsage.set([{ name: "USEast", usage: 0.12 }, { name: "USSouth3", usage: 0 }]);
    expect(depositBlock(db, "USEast")).toBe("busy");
    expect(withdrawBlock(db, "USEast")).toBe("busy");
    expect(depositBlock(db, "USSouth3")).toBe(null);
    expect(withdrawBlock(db, "USSouth3")).toBe(null);
    expect(blockMessage("USEast", "deposit", "busy")).toBe("USEast is busy right now (12% full) — trades only run on empty servers. Pick another server.");
  });

  it("does not act on a server the reading omits, or on a stale reading", () => {
    serverUsage.set([{ name: "USEast", usage: 0.5 }]);
    expect(depositBlock(db, "EUWest")).toBe(null);
    vi.advanceTimersByTime(USAGE_FRESH_MS + 1);
    expect(depositBlock(db, "USEast")).toBe(null);
    expect(serverUsage.fresh()).toBe(false);
    expect(getAllServerControls(db).find((c) => c.server === "USEast")).toMatchObject({ usage: null, busy: false });
  });

  it("puts the operator's toggle ahead of the load, and surfaces both in the controls list", () => {
    serverUsage.set([{ name: "USEast", usage: 0.5 }, { name: "EUWest", usage: 0.2 }]);
    setServerControl(db, "USEast", true, false);
    expect(depositBlock(db, "USEast")).toBe("disabled");
    expect(withdrawBlock(db, "USEast")).toBe("busy");
    const byName = Object.fromEntries(getAllServerControls(db).map((c) => [c.server, c]));
    expect(byName.USEast).toMatchObject({ depositsDisabled: true, withdrawsDisabled: false, usage: 0.5, busy: true });
    expect(byName.EUWest).toMatchObject({ depositsDisabled: false, usage: 0.2, busy: true });
    expect(byName.USSouth3).toMatchObject({ usage: null, busy: false });
  });

  it("keeps the last good reading through a fetch error until it ages out", () => {
    serverUsage.set([{ name: "USEast", usage: 0.5 }]);
    serverUsage.noteError("network: timeout");
    expect(serverUsage.status()).toMatchObject({ fresh: true, lastError: "network: timeout", servers: { USEast: 0.5 } });
    expect(depositBlock(db, "USEast")).toBe("busy");
  });
});
