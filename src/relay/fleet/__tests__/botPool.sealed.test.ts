// A roster the process cannot open (wrong or missing sealing key, corruption) is never overwritten.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "../botPool";
import { seal } from "../../../node/secrets";

let dir: string;
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("BotPool with a roster it cannot open", () => {
  it("leaves the file as it was through adds and changes", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-sealed-"));
    const file = path.join(dir, "Accounts.json");
    // Sealed with a key this process does not have.
    const foreign = seal(JSON.stringify([{ guid: "kept@hotmail.com", password: "pw" }]), Buffer.alloc(32, 5));
    fs.writeFileSync(file, foreign + "\n");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = BotPool.at(dir);
    expect(pool.all()).toHaveLength(0);
    pool.addPulled({ guid: "new@hotmail.com", password: "pw2", alias: "new" });
    const acc = pool.byGuid("new@hotmail.com");
    if (acc) pool.markSuspended(acc.guid);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(foreign);
  });
});
