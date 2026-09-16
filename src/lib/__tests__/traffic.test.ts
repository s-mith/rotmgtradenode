// Per-visitor traffic accounting: the in-memory counters, the hourly flush
// and its retention, and the report that ranks visitors and flags outliers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { flushTraffic, pendingTrafficCells, recordTraffic, resetTraffic, trafficReport, visitorKey, RETENTION_DAYS, UNUSUAL_MIN_BYTES, UNUSUAL_MIN_REQUESTS } from "../traffic";

const HOUR = 3_600_000;
const T0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR + 15 * 60_000; // a quarter past some hour
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  resetTraffic();
});
afterEach(() => {
  db.close();
  resetTraffic();
});

describe("counting", () => {
  it("keys visitors by IGN when logged in, else by IP", () => {
    expect(visitorKey("comrade", "1.2.3.4")).toBe("ign:comrade");
    expect(visitorKey(null, "1.2.3.4")).toBe("ip:1.2.3.4");
  });

  it("sums into hourly cells and writes them once per flush, merging with what is already there", () => {
    recordTraffic("ign:comrade", "/api/pool", 1000, T0);
    recordTraffic("ign:comrade", "/api/pool", 500, T0 + 1000);
    recordTraffic("ign:comrade", "/api/vault", 10, T0);
    recordTraffic("ip:1.2.3.4", "/api/pool", 1000, T0 + HOUR);
    expect(pendingTrafficCells()).toBe(3);
    expect(flushTraffic(db, T0 + HOUR)).toEqual({ cells: 3 });
    expect(pendingTrafficCells()).toBe(0);
    const hour0 = Math.floor(T0 / HOUR) * HOUR;
    expect(db.prepare("SELECT hour, who, route, requests, bytes FROM traffic_hourly ORDER BY hour, who, route").all()).toEqual([
      { hour: hour0, who: "ign:comrade", route: "/api/pool", requests: 2, bytes: 1500 },
      { hour: hour0, who: "ign:comrade", route: "/api/vault", requests: 1, bytes: 10 },
      { hour: hour0 + HOUR, who: "ip:1.2.3.4", route: "/api/pool", requests: 1, bytes: 1000 },
    ]);
    // A second flush adds to the same cell rather than replacing it.
    recordTraffic("ign:comrade", "/api/pool", 1, T0 + 2000);
    flushTraffic(db, T0 + HOUR);
    expect(db.prepare("SELECT requests, bytes FROM traffic_hourly WHERE who = 'ign:comrade' AND route = '/api/pool'").get()).toEqual({ requests: 3, bytes: 1501 });
    // An empty flush is a no-op that still applies retention.
    expect(flushTraffic(db, T0 + HOUR)).toEqual({ cells: 0 });
  });

  it("drops history past the retention", () => {
    recordTraffic("ign:old", "/api/pool", 5, T0 - (RETENTION_DAYS + 1) * 24 * HOUR);
    recordTraffic("ign:new", "/api/pool", 5, T0);
    flushTraffic(db, T0);
    expect(db.prepare("SELECT who FROM traffic_hourly").all()).toEqual([{ who: "ign:new" }]);
  });
});

describe("the report", () => {
  it("merges the table with unflushed counts, windows by hour, ranks by bytes, and breaks down routes", () => {
    recordTraffic("ign:comrade", "/api/pool", 3000, T0 - 2 * HOUR);
    recordTraffic("ign:comrade", "/api/vault", 100, T0 - 2 * HOUR);
    recordTraffic("ip:9.9.9.9", "/api/pool", 200, T0 - 30 * HOUR); // outside a 24h window
    flushTraffic(db, T0);
    recordTraffic("ign:buyer", "/api/pool", 5000, T0); // not flushed yet
    const r = trafficReport(db, { hours: 24, now: T0 });
    expect(r.hours).toBe(24);
    expect(r.from).toBe(Math.floor(T0 / HOUR) * HOUR - 23 * HOUR);
    expect(r.total).toEqual({ requests: 3, bytes: 8100, visitors: 2 });
    expect(r.visitors.map((v) => [v.who, v.bytes, v.requests, v.activeHours])).toEqual([
      ["ign:buyer", 5000, 1, 1],
      ["ign:comrade", 3100, 2, 1],
    ]);
    expect(r.visitors[1]).toMatchObject({ kind: "ign", id: "comrade", share: 3100 / 8100, routes: [{ route: "/api/pool", requests: 1, bytes: 3000 }, { route: "/api/vault", requests: 1, bytes: 100 }], unusual: false, why: null });
    // A wider window brings the old IP back.
    const wide = trafficReport(db, { hours: 48, now: T0 });
    expect(wide.total.visitors).toBe(3);
    expect(wide.visitors[2]).toMatchObject({ who: "ip:9.9.9.9", kind: "ip", id: "9.9.9.9" });
    expect(trafficReport(db, { hours: 24, now: T0, limit: 1 }).visitors).toHaveLength(1);
  });

  it("flags a visitor far above the typical one, but never a small crowd's biggest member", () => {
    // Three ordinary visitors and one that pulled the pool all day.
    for (const who of ["ign:a", "ign:b", "ign:c"]) {
      recordTraffic(who, "/api/pool", 2 * 1024 * 1024, T0);
      recordTraffic(who, "/api/recent", 2000, T0);
    }
    for (let h = 0; h < 12; h++) for (let i = 0; i < 300; i++) recordTraffic("ip:5.5.5.5", "/api/pool", 40 * 1024, T0 - h * HOUR);
    const r = trafficReport(db, { hours: 24, now: T0 });
    expect(r.visitors[0]).toMatchObject({ who: "ip:5.5.5.5", unusual: true, activeHours: 12, requests: 3600 });
    expect(r.visitors[0].bytes).toBe(3600 * 40 * 1024);
    expect(r.visitors[0].why).toMatch(/the typical visitor's bytes and .* its requests/);
    expect(r.visitors.slice(1).every((v) => !v.unusual)).toBe(true);
    // Many requests but few bytes (a tab polling and getting 304s) is flagged on requests alone.
    resetTraffic();
    db.exec("DELETE FROM traffic_hourly");
    for (const who of ["ign:a", "ign:b", "ign:c"]) recordTraffic(who, "/api/pool", 1000, T0);
    for (let i = 0; i < UNUSUAL_MIN_REQUESTS; i++) recordTraffic("ign:poller", "/api/pool", 0, T0);
    const p = trafficReport(db, { hours: 1, now: T0 });
    const poller = p.visitors.find((v) => v.who === "ign:poller")!;
    expect(poller).toMatchObject({ unusual: true, bytes: 0 });
    expect(poller.why).toMatch(/requests$/);
    // Alone, or merely the biggest of a few normal visitors, nobody is flagged.
    resetTraffic();
    db.exec("DELETE FROM traffic_hourly");
    recordTraffic("ign:solo", "/api/pool", UNUSUAL_MIN_BYTES * 2, T0);
    expect(trafficReport(db, { hours: 1, now: T0 }).visitors[0].unusual).toBe(false);
    recordTraffic("ign:other", "/api/pool", UNUSUAL_MIN_BYTES, T0);
    expect(trafficReport(db, { hours: 1, now: T0 }).visitors[0].unusual).toBe(false);
  });
});
