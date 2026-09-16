import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeSettingsStore } from "../settings";

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
  it("survives a corrupt file", () => {
    fs.writeFileSync(path.join(dir, "node.json"), "{nope");
    expect(NodeSettingsStore.at(dir).get().telemetry.enabled).toBe(false);
  });
});
