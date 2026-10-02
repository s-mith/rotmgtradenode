import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { GameClient } from "../../client/gameClient";
import { readVaultInfo } from "../vaultTrip";

// A client that only emits packets: what readVaultInfo listens to.
function fakeClient(): GameClient & EventEmitter {
  const em = new EventEmitter() as GameClient & EventEmitter;
  (em as unknown as { recentPackets: () => { sent: string[]; recv: string[] } }).recentPackets = () => ({ sent: [], recv: ["MAPINFO@1", "VAULTINFO@2"] });
  return em;
}
const chunk = (vault: number[], last: boolean, rest: Partial<{ material: number[]; gift: number[]; potion: number[]; spoils: number[] }> = {}) => ({
  type: "VAULTINFO" as const, last, vaultObjectId: 10, materialObjectId: 11, giftObjectId: 12, potionObjectId: 13, spoilsObjectId: 14,
  vaultContents: vault, materialContents: rest.material ?? [], giftContents: rest.gift ?? [], potionContents: rest.potion ?? [], spoilsContents: rest.spoils ?? [], tail: Buffer.alloc(0),
});

describe("readVaultInfo", () => {
  it("returns the view when a chunk is flagged last", async () => {
    const c = fakeClient();
    const p = readVaultInfo(c, 1_000, () => {}, 50);
    c.emit("packet", chunk([1, -1], true, { gift: [5], potion: [-1] }));
    const v = await p;
    expect(v).toMatchObject({ vault: { objectId: 10, slots: [1, -1] }, gift: { objectId: 12, slots: [5] }, potion: { objectId: 13, slots: [-1] } });
  });
  it("takes a chunked sequence as over when no chunk follows within the quiet window, keeping what came", async () => {
    // A 566-chest vault came as two 2048-slot chunks and no last one (live 2026-09-22).
    const c = fakeClient();
    const lines: string[] = [];
    const p = readVaultInfo(c, 5_000, (l) => lines.push(l), 40);
    c.emit("packet", chunk([1, 2], false, { material: [7] }));
    setTimeout(() => c.emit("packet", chunk([3, -1], false)), 10);
    const v = await p;
    expect(v?.vault.slots).toEqual([1, 2, 3, -1]);
    expect(v?.material.slots).toEqual([7]);
    expect(lines.at(-1)).toContain("ended without a last packet after 2 chunk(s)");
  });
  it("gives up without a view when no chunk comes at all", async () => {
    const c = fakeClient();
    expect(await readVaultInfo(c, 30, () => {}, 20)).toBeNull();
  });
});
