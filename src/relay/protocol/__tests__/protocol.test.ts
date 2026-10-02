// Byte-for-byte agreement with the original Python implementation. The
// fixtures are produced by scripts/gen-relay-fixtures.py from pyrelay's own
// packet classes, so a green run here means the TypeScript codecs read and
// write exactly what the fleet has been speaking.
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures.json";
import sessionFixtures from "./session-fixtures.json";
// Calendar / vault / season packets: layouts as rotmgproxy verified them on the wire (2026-09); bytes from our own writer.
import backpackFixtures from "./backpack-fixtures.json";
// Party / teleport packets (build 7.0): layouts from the client's protocol dump and rotmgproxy's captures (party.test.ts has the live bytes); bytes from our own writer.
import partyFixtures from "./party-fixtures.json";
import { RC4 } from "../rc4";
import { PacketReader } from "../reader";
import { PacketWriter } from "../writer";
import { CODECS, isKnownPacket, type PacketName } from "../packets";
import { decodePayload, encodeFrame, HEADER_SIZE } from "../codec";
import { PACKET_ID_TO_NAME } from "../packetIds";
import { decodeEnchantRecord, enchantCount } from "../enchants";

type Fixture = { name: string; id: number; fields: Record<string, unknown>; hex: string };

/** Bring a decoded packet into the JSON shape the fixture uses. Only the
 *  packet-level `type` discriminator is dropped; nested fields named `type`
 *  (a ground tile's) are data. */
function normalize(v: unknown, top = false): unknown {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (top && k === "type") continue;
      out[k] = normalize(x);
    }
    return out;
  }
  return v;
}

/** Turn fixture fields into the TS packet shape (byte arrays -> Buffer). */
function denormalize(name: PacketName, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  if (name === "HELLO" || name === "RECONNECT") out.key = Buffer.from(fields.key as number[]);
  if (name === "VAULTINFO") out.tail = Buffer.from(fields.tail as number[]);
  return out;
}

describe("rc4", () => {
  for (const [dir, f] of Object.entries(fixtures.rc4)) {
    it(`${dir} keystream matches`, () => {
      const c = new RC4(f.key);
      const a = c.process(new Uint8Array(32));
      const b = c.process(new Uint8Array(32));
      expect(Buffer.concat([a, b]).toString("hex")).toBe(f.keystream64);
    });
  }
  it("is symmetric across two instances", () => {
    const plain = Buffer.from("hello realm, this is a test frame payload");
    const enc = new RC4(fixtures.rc4.outgoing.key).process(Buffer.from(plain));
    const dec = new RC4(fixtures.rc4.outgoing.key).process(enc);
    expect(Buffer.from(dec)).toEqual(plain);
  });
});

describe("compressed int", () => {
  for (const c of fixtures.compressed) {
    it(`round-trips ${c.value}`, () => {
      const w = new PacketWriter();
      w.writeCompressedInt(c.value);
      expect(w.payload().toString("hex")).toBe(c.hex);
      expect(new PacketReader(Buffer.from(c.hex, "hex")).readCompressedInt()).toBe(c.value);
    });
  }
});

describe("enchant records", () => {
  for (const e of fixtures.enchants) {
    it(`decodes ${JSON.stringify(e.payload).slice(0, 24)}`, () => {
      // The Python decoder returned [] for malformed input; ours says null (unreadable).
      expect(decodeEnchantRecord(e.payload) ?? []).toEqual(e.ids);
      expect(enchantCount(e.payload)).toBe(e.count);
    });
  }
});

describe("packet codecs vs pyrelay", () => {
  const cases = [...fixtures.packets, ...sessionFixtures.packets, ...backpackFixtures.packets, ...partyFixtures.packets] as Fixture[];
  const covered = new Set<string>();
  for (const [i, c] of cases.entries()) {
    covered.add(c.name);
    it(`${c.name} #${i}: decode python bytes`, () => {
      const frame = Buffer.from(c.hex, "hex");
      expect(frame.readInt32BE(0)).toBe(frame.length);
      expect(frame.readUInt8(4)).toBe(c.id);
      expect(PACKET_ID_TO_NAME[c.id]).toBe(c.name);
      const pkt = decodePayload(c.id, frame.subarray(HEADER_SIZE));
      expect(pkt.type).toBe(c.name);
      expect(normalize(pkt, true)).toEqual(c.fields);
    });
    it(`${c.name} #${i}: encode matches python bytes`, () => {
      if (!isKnownPacket(c.name)) throw new Error("unknown packet in fixtures");
      const body = denormalize(c.name, c.fields);
      const frame = encodeFrame(c.name, body as never);
      expect(frame.toString("hex")).toBe(c.hex);
    });
  }
  it("every codec has a fixture", () => {
    const missing = (Object.keys(CODECS) as PacketName[]).filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });
});

describe("unknown packets", () => {
  it("fall through with their payload instead of throwing", () => {
    const pkt = decodePayload(139, Buffer.from([1, 2, 3]));
    expect(pkt.type).toBe("UNKNOWN");
    if (pkt.type === "UNKNOWN") expect(Array.from(pkt.payload)).toEqual([1, 2, 3]);
  });
  it("reports underflow on a truncated frame", () => {
    expect(() => decodePayload(0, Buffer.from([0, 0]))).toThrow(RangeError);
  });
});

describe("enchant records — extended and malformed", () => {
  const base = Buffer.from("AAIEBQAQAP3__f8FAA", "base64url"); // ids [5, 16]
  it("ignores item state appended after the 13-byte base record (charge bars)", () => {
    const extended = Buffer.concat([base, Buffer.from([0x01, 0x00, 0x2a, 0x00, 0x00, 0x00])]).toString("base64url");
    expect(decodeEnchantRecord(extended)).toEqual([5, 16]);
    expect(enchantCount(extended)).toBe(2);
  });
  it("decodes all four reserved entries", () => {
    const four = Buffer.from(base);
    four.writeUInt16LE(7, 7);
    four.writeUInt16LE(9, 9);
    expect(decodeEnchantRecord(four.toString("base64url"))).toEqual([5, 16, 7, 9]);
  });
  it("empty payload is zero enchantments, not unreadable", () => {
    expect(decodeEnchantRecord("")).toEqual([]);
    expect(enchantCount("")).toBe(0);
  });
  it("rejects short, wrong-prefix, and non-base64url records as unreadable", () => {
    expect(decodeEnchantRecord(base.subarray(0, 12).toString("base64url"))).toBeNull();
    const badPrefix = Buffer.from(base);
    badPrefix[2] = 0x02;
    expect(decodeEnchantRecord(badPrefix.toString("base64url"))).toBeNull();
    expect(decodeEnchantRecord("not/base64url+==")).toBeNull();
    expect(enchantCount("not/base64url+==")).toBe(0);
  });
});

describe("enchant records — live captures 2026-09-02 (padded, extended)", () => {
  it("padded ordinary record", () => {
    expect(decodeEnchantRecord("AAIEvQX9__3__f8FAA==")).toEqual([0x05bd]);
  });
  it("padded charge-bar record with item state", () => {
    expect(decodeEnchantRecord("AAIEcAW8A_3__f8FAQAAAA==")).toEqual([0x0570, 0x03bc]);
    expect(decodeEnchantRecord("AAIE_f_9__3__f8FAQAAAA==")).toEqual([]);
    expect(enchantCount("AAIEGgNAAP3__f8FAQAAAA==")).toBe(2);
  });
});

describe("stat 78 — live capture 2026-09-04", () => {
  // A USSouth Nexus UPDATE carried stat 78 as a u16-length string
  // ("Sebchoof|Sebchoof"); read as an int it desynced the whole packet.
  it("decodes as a string and leaves the following stat aligned", async () => {
    const { ObjectStatus } = await import("../data");
    const { Stat } = await import("../stats");
    const w = new PacketWriter();
    ObjectStatus.write(w, {
      objectId: 5,
      pos: { x: 1, y: 2 },
      stats: [
        { statType: 78, statValue: 0, strStatValue: "Sebchoof|Sebchoof", secondaryValue: 0 },
        { statType: Stat.NAME, statValue: 0, strStatValue: "Sebchoof", secondaryValue: 0 },
      ],
    });
    const hex = w.payload().toString("hex");
    // Wire prefix matches what the relay logged: type 0x4e, length 0x0011, "Sebchoof|S".
    expect(hex).toContain("4e001153656263686f6f667c53");
    const got = ObjectStatus.read(new PacketReader(w.payload()));
    expect(got.stats.map((s) => [s.statType, s.strStatValue])).toEqual([[78, "Sebchoof|Sebchoof"], [Stat.NAME, "Sebchoof"]]);
  });
});
