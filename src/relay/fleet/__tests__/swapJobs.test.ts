import { describe, expect, it } from "vitest";
import { swapAssignment, swapResult } from "../swapJobs";

const base = { kind: "withdraw" as const, requestId: 7, ign: "PartnerBot", server: "USSouth3", botIgn: "Me", vault: null };
const give = [{ itemId: "patk", qty: 2 }];
const gets = [{ itemId: "pdef", qty: 1 }];

describe("swap assignments", () => {
  it("the poster's side gives and expects the taker's items back", () => {
    const a = swapAssignment({ ...base, items: give, instanceIds: ["i1", "i2"], swap: { rendezvousId: 3, role: "give", gets } });
    expect(a).toEqual({ kind: "consolidate_give", requestId: 7, partnerIgn: "PartnerBot", items: give, instanceIds: ["i1", "i2"], swapItems: gets, itemCount: 3 });
  });
  it("the taker's side puts up its exact instances and expects the poster's items", () => {
    const a = swapAssignment({ ...base, items: gets, instanceIds: ["t1"], swap: { rendezvousId: 3, role: "take", gets: give } });
    expect(a).toEqual({ kind: "consolidate_take", requestId: 7, partnerIgn: "PartnerBot", items: give, swapItems: gets, swapInstanceIds: ["t1"], itemCount: 3 });
  });
});

describe("swap results", () => {
  it("reads gave/got the right way round for each role", () => {
    const giver = { ...base, items: give, instanceIds: ["i1", "i2"], swap: { rendezvousId: 3, role: "give" as const, gets } };
    expect(swapResult(giver, { ok: true, kind: "consolidate_give", consolidated: give, swapItems: gets })).toEqual({ ok: true, gave: give, gaveInstanceIds: ["i1", "i2"], got: gets, partnerIgn: "PartnerBot" });
    const taker = { ...base, items: gets, instanceIds: ["t1"], swap: { rendezvousId: 3, role: "take" as const, gets: give } };
    expect(swapResult(taker, { ok: true, kind: "consolidate_take", consolidated: give, swapItems: gets })).toEqual({ ok: true, gave: gets, gaveInstanceIds: ["t1"], got: give, partnerIgn: "PartnerBot" });
  });
  it("a failure carries the reason and whether the partner never showed", () => {
    const giver = { ...base, items: give, instanceIds: ["i1"], swap: { rendezvousId: 3, role: "give" as const, gets } };
    expect(swapResult(giver, { ok: false, error: "partner not in view", partnerAbsent: true })).toMatchObject({ ok: false, error: "partner not in view", partnerAbsent: true, gave: [] });
  });
});
