import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advancedFor, DEFAULT_ADVANCED, NodeSettingsStore, normalizeAdvanced, normalizeSetup, playerMeetingsAtOnce } from "../settings";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-settings-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("NodeSettingsStore", () => {
  it("starts with telemetry off and a fresh salt, and persists changes", () => {
    const a = NodeSettingsStore.at(dir);
    expect(a.get().telemetry.enabled).toBe(false);
    expect(a.get().telemetry.salt.length).toBeGreaterThan(10);
    expect(a.get().knownBuilds).toEqual([]);
    a.update((s) => { s.telemetry.enabled = true; s.telemetry.hubUrl = "https://hub.example"; s.knownBuilds.push("7.0.0.9.0"); });
    const b = NodeSettingsStore.at(dir);
    expect(b.get().telemetry).toEqual({ enabled: true, hubUrl: "https://hub.example", salt: a.get().telemetry.salt });
    expect(b.get().knownBuilds).toEqual(["7.0.0.9.0"]);
  });
  it("keeps trades with players off until the owner turns them on; meetings default to one per bot online", () => {
    const a = NodeSettingsStore.at(dir);
    const noShow = { limit: 2, pauseHours: 24 };
    expect(a.get().players).toEqual({ enabled: false, maxMeetings: null, noShow });
    expect(playerMeetingsAtOnce(a.get().players, 5)).toBe(5);
    expect(playerMeetingsAtOnce(a.get().players, 0)).toBe(1);
    a.update((s) => { s.players = { enabled: true, maxMeetings: 3, noShow: { limit: 0, pauseHours: 24 } }; });
    expect(NodeSettingsStore.at(dir).get().players).toEqual({ enabled: true, maxMeetings: 3, noShow: { limit: 0, pauseHours: 24 } });
    expect(playerMeetingsAtOnce(NodeSettingsStore.at(dir).get().players, 5)).toBe(3);
    // An owner who picks 2 keeps 2; a file from before (no noShow) that still says 2 had the old default, and gets the new one.
    a.update((s) => { s.players = { enabled: true, maxMeetings: 2, noShow }; });
    expect(NodeSettingsStore.at(dir).get().players.maxMeetings).toBe(2);
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ players: { enabled: true, maxMeetings: 2 } }));
    expect(NodeSettingsStore.at(dir).get().players).toEqual({ enabled: true, maxMeetings: null, noShow });
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ players: { enabled: "yes", maxMeetings: 9999, noShow: { limit: -1, pauseHours: "x" } } }));
    expect(NodeSettingsStore.at(dir).get().players).toEqual({ enabled: false, maxMeetings: null, noShow });
  });
  it("keeps advanced management off for both pools until the owner turns each on", () => {
    const a = NodeSettingsStore.at(dir);
    expect(a.get().advanced).toEqual({ pool: false, communism: false, mergeBudget: "unlimited", lingerS: 0, passSurplus: true });
    expect(advancedFor(a.get().advanced, false)).toBe(false);
    expect(advancedFor(a.get().advanced, true)).toBe(false);
    a.update((s) => { s.advanced = normalizeAdvanced({ ...s.advanced, communism: true, mergeBudget: "demand", lingerS: 15 }); });
    const b = NodeSettingsStore.at(dir).get().advanced;
    expect(b).toEqual({ pool: false, communism: true, mergeBudget: "demand", lingerS: 15, passSurplus: true });
    expect(advancedFor(b, true)).toBe(true);
    expect(advancedFor(b, false)).toBe(false);
    // Anything odd falls back to the defaults: off, unlimited, 0 s.
    expect(normalizeAdvanced({ pool: "yes", communism: 1, mergeBudget: "lots", lingerS: 7, passSurplus: "no" })).toEqual({ ...DEFAULT_ADVANCED });
    expect(normalizeAdvanced(null)).toEqual(DEFAULT_ADVANCED);
  });
  it("survives a corrupt file", () => {
    fs.writeFileSync(path.join(dir, "node.json"), "{nope");
    expect(NodeSettingsStore.at(dir).get().telemetry.enabled).toBe(false);
  });
  it("keeps the first-run setup and own internet, and says when no setup record was stored", () => {
    const a = NodeSettingsStore.at(dir);
    expect(a.setupWasMissing).toBe(true);
    expect(a.get().setup).toEqual({ completedAt: null, hubSkipped: false });
    expect(a.get().proxies).toEqual({ required: true, ownInternetAt: null });
    a.update((s) => { s.setup = { completedAt: 1_800_000_000_000, hubSkipped: true }; s.proxies = { required: false, ownInternetAt: 1_800_000_000_001 }; });
    const b = NodeSettingsStore.at(dir);
    expect(b.setupWasMissing).toBe(false);
    expect(b.get().setup).toEqual({ completedAt: 1_800_000_000_000, hubSkipped: true });
    expect(b.get().proxies).toEqual({ required: false, ownInternetAt: 1_800_000_000_001 });
    // A file from before the setup existed: no record, so the fleet decides once.
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ proxies: { required: false } }));
    const old = NodeSettingsStore.at(dir);
    expect(old.setupWasMissing).toBe(true);
    expect(old.get().proxies).toEqual({ required: false, ownInternetAt: null });
    // A file that can't be read is not taken for a missing record.
    fs.writeFileSync(path.join(dir, "node.json"), "{nope");
    expect(NodeSettingsStore.at(dir).setupWasMissing).toBe(false);
    expect(normalizeSetup({ completedAt: "soon", hubSkipped: "yes" })).toEqual({ completedAt: null, hubSkipped: false });
    expect(normalizeSetup({ completedAt: -5 })).toEqual({ completedAt: null, hubSkipped: false });
  });
});
