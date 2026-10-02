import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Realm's answer to an account check.
vi.mock("../fleet/accountProbe", () => ({
  probeAccount: vi.fn(async () => ({ verdict: "bad-credentials", detail: "", chars: [], tutorialDone: false, loaded: null })),
}));
import { Fleet } from "../fleet/fleet";
import { createControlPlane } from "../controlPlane";
import { probeAccount } from "../fleet/accountProbe";
import type { GameClient } from "../client/gameClient";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
  vi.mocked(probeAccount).mockClear();
});

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cp-acc-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]));
  const fleet = new Fleet({ dataDir, buildVersion: "7.0.0.0.0", log: () => {}, proxies: { file: path.join(dataDir, "none.txt") } });
  fleet.nodeSettings.update((s) => { s.proxies.required = false; });
  cleanup.push(() => fleet.stop());
  const app = createControlPlane(fleet, () => "secret");
  const call = async (p: string, json: unknown) => {
    const res = await app.fetch(new Request(`http://relay.local${p}`, { method: "POST", headers: { "X-Pyrelay-Auth": "secret", "Content-Type": "application/json" }, body: JSON.stringify(json) }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { fleet, call };
}

describe("adding an account", () => {
  it("always asks Realm: probe:false no longer skips the check", async () => {
    const { fleet, call } = setup();
    const r = await call("/accounts", { email: "new@example.com", password: "pw", probe: false });
    expect(r.status).toBe(400);
    expect(vi.mocked(probeAccount)).toHaveBeenCalledTimes(1);
    expect(fleet.pool.byGuid("new@example.com")).toBeFalsy();
  });
});

describe("pointing an account at a different email", () => {
  it("counts what its storage holds, not only the played character", async () => {
    const { fleet, call } = setup();
    const acc = fleet.pool.all()[0];
    vi.spyOn(fleet.storage, "storedFor").mockReturnValue([{ instanceId: "v1" } as never]);
    const r = await call("/accounts/credentials", { guid: acc.guid, email: "other@example.com", password: "pw" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/holds 1 item/);
    expect(vi.mocked(probeAccount)).not.toHaveBeenCalled();
  });
  it("is refused while a maintenance routine drives the account", async () => {
    const { fleet, call } = setup();
    const acc = fleet.pool.all()[0];
    fleet.clients.set(acc.guid, { active: true } as unknown as GameClient);
    const r = await call("/accounts/credentials", { guid: acc.guid, password: "pw2" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/online/);
    fleet.clients.delete(acc.guid);
  });
});
