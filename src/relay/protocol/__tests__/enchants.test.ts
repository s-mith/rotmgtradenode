import { describe, expect, it } from "vitest";
import { decodeEnchantRecord, decodeSnapshotRecord } from "../enchants";

const live = "AAIEcAW8A_3__f8FAQAAAA=="; // 00 02 04 | 0570 03bc fffd fffd | 05 01 000000 (confirmed live 2026-09-02)

describe("decodeEnchantRecord (the stat)", () => {
  it("reads the four entries and skips every sentinel", () => {
    expect(decodeEnchantRecord(live)).toEqual([0x570, 0x3bc]);
    const b = Buffer.from([0, 2, 4, 0x11, 0, 0xfe, 0xff, 0xff, 0xff, 0xfd, 0xff, 5, 0]);
    expect(decodeEnchantRecord(b.toString("base64url"))).toEqual([17]);
  });
});

describe("decodeSnapshotRecord (char/list ItemData)", () => {
  const rec = (entries: number[], type = 596): Buffer => {
    const b = Buffer.alloc(3 + 2 * entries.length);
    b.writeUInt16LE(type, 1);
    entries.forEach((e, i) => b.writeUInt16LE(e, 3 + 2 * i));
    return b;
  };
  it("takes entries from byte 3 until the terminator, ignoring locked and empty markers, either base64 alphabet, padded or not", () => {
    const b = rec([17, 0xfffe, 0xffff, 0xfffd, 0x1234]);
    expect(decodeSnapshotRecord(b.toString("base64url"))).toEqual([17]);
    expect(decodeSnapshotRecord(b.toString("base64"))).toEqual([17]);
    expect(decodeSnapshotRecord(b.toString("base64url") + "==")).toEqual([17]);
    expect(decodeSnapshotRecord(rec([3, 4]).toString("base64url"))).toEqual([3, 4]);
    // The live stat's layout decodes the same way.
    expect(decodeSnapshotRecord(live)).toEqual([0x570, 0x3bc]);
  });
  it("caps at four entries and is empty for short or unreadable records", () => {
    expect(decodeSnapshotRecord(rec([1, 2, 3, 4, 5]).toString("base64url"))).toEqual([1, 2, 3, 4]);
    expect(decodeSnapshotRecord("")).toEqual([]);
    expect(decodeSnapshotRecord("AAA=")).toEqual([]);
    expect(decodeSnapshotRecord("not base64!")).toEqual([]);
  });
});
