import { describe, expect, it } from "vitest";
import { swapAssignment, swapResult } from "../swapJobs";

const base = { kind: "withdraw" as const, requestId: 7, ign: "PartnerBot", server: "USSouth3", botIgn: "Me", vault: null };
const give = [{ itemId: "patk", qty: 2 }];
const gets = [{ itemId: "pdef", qty: 1 }];

describe("swap assignments", () => {
  it("the poster's side gives and expects the taker's items back", () => {
    const a = swapAssignment({ ...base, items: give, instanceIds: ["i1", "i2"], swap: { rendezvousId: 3, role: "give", gets } });
    expect(a).toEqual({ kind: "consolidate_give", requestId: 7, partnerIgn: "PartnerBot", items: give, instanceIds: ["i1", "i2"], swapItems: gets, itemCount: 3, meetingDeadlineAt: null, expectIncoming: null });
  });
  it("the taker's side puts up its exact instances and expects the poster's items", () => {
    const a = swapAssignment({ ...base, items: gets, instanceIds: ["t1"], swap: { rendezvousId: 3, role: "take", gets: give } });
    expect(a).toEqual({ kind: "consolidate_take", requestId: 7, partnerIgn: "PartnerBot", items: give, swapItems: gets, swapInstanceIds: ["t1"], itemCount: 3, meetingDeadlineAt: null, expectIncoming: null });
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

describe("meetings", () => {
  it("carries the meeting's deadline and per-item enchantments into the assignment", () => {
    const a = swapAssignment({ ...base, items: give, instanceIds: ["i1", "i2"], swap: { rendezvousId: 3, role: "give", gets, getsItems: [{ itemId: "pdef", enchants: [5], count: 1 }], deadlineAt: 123 } });
    expect(a).toMatchObject({ kind: "consolidate_give", meetingDeadlineAt: 123, expectIncoming: [{ itemId: "pdef", enchants: [5] }] });
    const t = swapAssignment({ ...base, items: gets, instanceIds: ["t1"], swap: { rendezvousId: 3, role: "take", gets: give, getsItems: [{ itemId: "patk", enchants: null, count: 0 }, { itemId: "patk", enchants: [], count: 0 }], deadlineAt: 456 } });
    expect(t).toMatchObject({ kind: "consolidate_take", meetingDeadlineAt: 456, expectIncoming: [{ itemId: "patk", enchants: null }, { itemId: "patk", enchants: [] }] });
  });
  it("reports the partner as the trade window named it and what crossed per item", () => {
    const giver = { ...base, items: give, instanceIds: ["i1", "i2"], swap: { rendezvousId: 3, role: "give" as const, gets } };
    const r = swapResult(giver, { ok: true, kind: "consolidate_give", consolidated: give, swapItems: gets, partnerName: "Partnerbot", ourOffered: [{ itemId: "patk", enchants: [] }, { itemId: "patk", enchants: [7] }], partnerOffered: [{ itemId: "pdef", enchants: null }] });
    expect(r).toMatchObject({ ok: true, partnerIgn: "Partnerbot", gaveItems: [{ itemId: "patk", enchants: [], count: 0 }, { itemId: "patk", enchants: [7], count: 1 }], gotItems: [{ itemId: "pdef", enchants: null, count: 0 }] });
    expect(swapResult(giver, { ok: false, error: "trade timeout", partnerName: "Partnerbot" })).toMatchObject({ ok: false, partnerIgn: "Partnerbot", error: "trade timeout" });
  });
});

describe("player meetings", () => {
  const lines = [{ itemId: "pdef", qty: 2, slotsMin: 0, slotsExact: null, enchants: [] }];
  const row = { ...base, ign: "SomePlayer", items: give, instanceIds: ["i1", "i2"], swap: { rendezvousId: 4, role: "give" as const, gets: [{ itemId: "pdef", qty: 2 }], deadlineAt: 999, player: { lines } } };

  it("become a player swap that judges what comes back by the offer's want lines", () => {
    const a = swapAssignment(row);
    expect(a).toMatchObject({ kind: "player_swap", partnerIgn: "SomePlayer", items: give, instanceIds: ["i1", "i2"], meetingDeadlineAt: 999, incomingCount: 2, itemCount: 4 });
    const check = a.incomingCheck!;
    expect(check([{ itemId: "pdef", enchants: [] }], false)).toEqual({ ok: true });
    expect(check([{ itemId: "pdef", enchants: [] }], true)).toMatchObject({ ok: false, why: expect.stringContaining("still missing 1×") });
    expect(check([{ itemId: "pdef", enchants: [] }, { itemId: "pdef", enchants: null }], true)).toEqual({ ok: true });
    expect(check([{ itemId: "patk", enchants: [] }], false)).toMatchObject({ ok: false });
  });

  it("report what the window showed crossing", () => {
    const r = swapResult(row, { ok: true, kind: "player_swap", gave: give, got: [{ itemId: "pdef", qty: 2 }], partnerName: "Someplayer", ourOffered: [{ itemId: "patk", enchants: [] }, { itemId: "patk", enchants: [] }], partnerOffered: [{ itemId: "pdef", enchants: [4] }, { itemId: "pdef", enchants: null }] });
    expect(r).toEqual({
      ok: true, gave: give, gaveInstanceIds: ["i1", "i2"], got: [{ itemId: "pdef", qty: 2 }], partnerIgn: "Someplayer",
      gaveItems: [{ itemId: "patk", enchants: [], count: 0 }, { itemId: "patk", enchants: [], count: 0 }], gotItems: [{ itemId: "pdef", enchants: [4], count: 1 }, { itemId: "pdef", enchants: null, count: 0 }],
    });
  });
});
