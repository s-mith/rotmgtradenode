// Party and teleport packets (build 7.0): layouts from the client's protocol
// dump, checked against what rotmgproxy saw on the wire on 2026-09-13 — a
// real party-list page and party action, and the sizes of the packets whose
// bytes were not captured (docs/REALMHUNTS.md §6).
import { describe, expect, it } from "vitest";
import { PacketReader } from "../reader";
import { PacketWriter } from "../writer";
import { CODECS, type PacketName, type Packets } from "../packets";
import { PACKET_ID_TO_NAME, PACKET_NAME_TO_ID } from "../packetIds";

function write<K extends PacketName>(name: K, p: Packets[K]): Buffer {
  const w = new PacketWriter();
  CODECS[name].write(w, p);
  return w.payload();
}
function read<K extends PacketName>(name: K, hex: string): Packets[K] {
  return CODECS[name].read(new PacketReader(Buffer.from(hex, "hex")));
}

// The last page of the party finder as USSouth served it (271 bytes): packetNumber 0xff, 11 parties.
const LIST_PAGE = "ff000b00057075707079000025eb00000232000100000012496365204369746164656c204578616c7473000025ef000002320001000a002561616161616161616161616161616161616161616161616161616161616161616161616161000025f300000132000100000008696e207468657265000025f50000020600010000000e6d6f73206d6f6d6d61206d696e65000025f60000020400010000000467727567000025f80000030a0001000800076c696c206a6974000025fb000002030001000000067a6772656773000025fd0000020700010000000653616c616d69000025fe00000304000100000005627269636b000025ff000001320001000c0004616f6261000026000000020c00010000";

describe("party packet ids", () => {
  it("are the build 7.0 ids", () => {
    expect(PACKET_NAME_TO_ID).toMatchObject({ TELEPORT: 1, CREATEPARTY: 200, PARTYACTION: 204, PARTYACTIONRESULT: 207, PARTYINVITE: 208, PARTYINVITERESPONSE: 209, PARTYMEMBERINFO: 210, PARTYMEMBERADDED: 212, PARTYLIST: 214, PARTYJOINREQUEST: 215, PARTYJOINREQUESTRESPONSE: 217 });
    expect(PACKET_ID_TO_NAME[204]).toBe("PARTYACTION");
  });
});

describe("live bytes", () => {
  it("PARTYACTION: the party-list request is player 0xffff, action 5; refresh is action 4; teleport to a member is their party player id, action 7", () => {
    expect(read("PARTYACTION", "ffff05")).toEqual({ playerId: 0xffff, actionId: 5 });
    expect(read("PARTYACTION", "ffff04")).toEqual({ playerId: 0xffff, actionId: 4 });
    expect(read("PARTYACTION", "01f507")).toEqual({ playerId: 0x01f5, actionId: 7 }); // answered by a RECONNECT into the member's dungeon
    // No party: 0xffffffff, not 0.
    expect(read("PARTYMEMBERINFO", "ffffffff00000000000000")).toEqual({ partyId: 0xffffffff, unknownShort: 0, maxSize: 0, players: [], description: "" });
    expect(read("PARTYMEMBERADDED", "021a00064a6574736f6e0321a1c0")).toEqual({ playerId: 0x021a, name: "Jetson", classId: 0x0321, skinId: 0xa1c0 });
    expect(write("PARTYACTION", { playerId: 0xffff, actionId: 6 }).toString("hex")).toBe("ffff06");
  });
  it("PARTYLIST: a last page decodes, and writes back byte for byte", () => {
    const p = read("PARTYLIST", LIST_PAGE);
    expect(p.packetNumber).toBe(0xff);
    expect(p.parties).toHaveLength(11);
    expect(p.parties[0]).toEqual({ description: "puppy", partyId: 0x25eb, minPowerLevel: 0, size: 2, maxSize: 50, activity: 0, privacy: 1, minStats: 0, serverIndex: 0 });
    expect(p.parties[1]).toMatchObject({ description: "Ice Citadel Exalts", partyId: 0x25ef, size: 2, maxSize: 50, serverIndex: 10 });
    expect(p.parties[10]).toMatchObject({ description: "aoba", partyId: 0x2600, size: 2, maxSize: 12, privacy: 1 });
    expect(write("PARTYLIST", p).toString("hex")).toBe(LIST_PAGE);
  });
  it("PARTYMEMBERINFO is 11 bytes with no party, and 68 with one member named Stockings and a 40-character description (the sizes seen live)", () => {
    const none = write("PARTYMEMBERINFO", { partyId: 0, unknownShort: 0, maxSize: 0, players: [], description: "" });
    expect(none).toHaveLength(11);
    expect(read("PARTYMEMBERINFO", none.toString("hex"))).toEqual({ partyId: 0, unknownShort: 0, maxSize: 0, players: [], description: "" });
    const one = { partyId: 9999, unknownShort: 1, maxSize: 50, players: [{ playerId: 7, name: "Stockings", classId: 0x030e, skinId: 0 }], description: "x".repeat(40) };
    const bytes = write("PARTYMEMBERINFO", one);
    expect(bytes).toHaveLength(68);
    expect(read("PARTYMEMBERINFO", bytes.toString("hex"))).toEqual(one);
  });
  it("CREATEPARTY with a 40-character description is 49 bytes (as sent live) and round-trips; PARTYMEMBERADDED for a 3-letter name is 11", () => {
    const p = { description: "y".repeat(40), minPowerLevel: 0, maxPartySize: 50, activity: 2, maxedStatReq: 0, privacy: 1, serverIndex: 5 };
    const bytes = write("CREATEPARTY", p);
    expect(bytes).toHaveLength(49);
    expect(read("CREATEPARTY", bytes.toString("hex"))).toEqual(p);
    const added = { playerId: 12, name: "Aki", classId: 0x0300, skinId: 0 };
    const a = write("PARTYMEMBERADDED", added);
    expect(a).toHaveLength(11);
    expect(read("PARTYMEMBERADDED", a.toString("hex"))).toEqual(added);
  });
});

describe("round trips", () => {
  it("TELEPORT, PARTYACTIONRESULT, PARTYINVITE(+RESPONSE), PARTYJOINREQUEST both ways, PARTYJOINREQUESTRESPONSE", () => {
    const tp = { objectId: 123456, playerName: "Stockings" };
    expect(read("TELEPORT", write("TELEPORT", tp).toString("hex"))).toEqual(tp);
    expect(read("PARTYACTIONRESULT", "000c06")).toEqual({ playerId: 12, result: 6 });
    const inv = { partyId: 0xfffffff0, inviterName: "Aki" };
    expect(read("PARTYINVITE", write("PARTYINVITE", inv).toString("hex"))).toEqual(inv);
    const resp = { partyId: 0x25eb, accept: 1 };
    expect(read("PARTYINVITERESPONSE", write("PARTYINVITERESPONSE", resp).toString("hex"))).toEqual(resp);
    // Client -> server (live: joining a public party): the party id and a byte 1; server -> client: the party id and the request's state.
    expect(write("PARTYJOINREQUEST", { partyId: 0x21f0, state: 1 }).toString("hex")).toBe("000021f001");
    expect(read("PARTYJOINREQUEST", "000021f001")).toEqual({ partyId: 0x21f0, state: 1 });
    expect(read("PARTYJOINREQUEST", "000025eb")).toEqual({ partyId: 0x25eb, state: 0 });
    const jr = { name: "Aki", classId: 0x0300, skinId: 2, state: 3 };
    expect(read("PARTYJOINREQUESTRESPONSE", write("PARTYJOINREQUESTRESPONSE", jr).toString("hex"))).toEqual(jr);
  });
});
