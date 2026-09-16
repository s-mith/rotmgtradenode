// Enchantment records, shared by the ENCHANTMENTS player stat (one record
// per inventory slot, comma-separated) and TradeItem.enchantment (one
// record). base64url of an equipment-v2 record:
//
//   00 02 04 | four little-endian uint16 entries | 05 00
//   00 02 04 | four little-endian uint16 entries | 05 01 | 3 state bytes   (charge bars)
//
// (confirmed live 2026-09-02: AAIEcAW8A_3__f8FAQAAAA== = 00 02 04 70 05 bc 03
// fd ff fd ff 05 01 00 00 00, two enchants + item state; the wire pads.)
//
// Bytes 3..10 are the four reserved enchant entries (0xFFFD = empty). The
// third header byte is the reserved capacity, always 4 on the wire even
// though this project's catalog uses at most two (MAX_ENCHANTS). Items with
// charge bars (Druid sigils) append state after the 13-byte base record; the
// old decoder demanded exactly 13 bytes and read those as unenchanted.
const BASE_LEN = 13;
const PREFIX = [0x00, 0x02, 0x04];
const EMPTY = 0xfffd;
/** What this project's catalog can carry; enforced at business boundaries, not here. */
export const MAX_ENCHANTS = 2;

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Enchant ids on one record. [] for an empty payload; null for a non-empty
 * record that is malformed or not the equipment-v2 layout.
 */
export function decodeEnchantRecord(payload: string): number[] | null {
  if (!payload) return [];
  // Live records are padded ("...FAA=="); canonical base64url is not.
  const body = payload.replace(/=+$/, "");
  if (!B64URL.test(body)) return unreadable(payload, "not base64url");
  const rec = Buffer.from(body, "base64url");
  if (rec.toString("base64url") !== body) return unreadable(payload, "non-canonical base64url");
  if (rec.length < BASE_LEN) return unreadable(payload, `short (${rec.length} bytes)`);
  if (rec[0] !== PREFIX[0] || rec[1] !== PREFIX[1] || rec[2] !== PREFIX[2]) return unreadable(payload, `prefix ${rec.subarray(0, 3).toString("hex")}`);
  if (rec.length > BASE_LEN) noteExtended(payload, rec);
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const id = rec.readUInt16LE(3 + i * 2);
    if (id !== EMPTY) out.push(id);
  }
  return out;
}

/** Number of enchantments on a TradeItem payload; unreadable counts as 0. */
export function enchantCount(payload: string): number {
  return decodeEnchantRecord(payload)?.length ?? 0;
}

/** The ENCHANTMENTS stat: 20 per-slot id lists (4 equip + 8 main + 8 backpack). */
export function decodeEnchantStat(raw: string): number[][] {
  const out: number[][] = Array.from({ length: 20 }, () => []);
  if (!raw) return out;
  const entries = raw.split(",");
  for (let i = 0; i < entries.length && i < 20; i++) {
    if (entries[i]) out[i] = decodeEnchantRecord(entries[i]) ?? [];
  }
  return out;
}

// --- diagnostics: first few distinct oddities go to the log ----------------
const seenUnreadable = new Set<string>();
const seenExtended = new Set<string>();
const DIAG_LIMIT = 8;
export const enchantDiagnostics = { unreadable: seenUnreadable, extended: seenExtended };

function unreadable(payload: string, why: string): null {
  if (seenUnreadable.size < DIAG_LIMIT && !seenUnreadable.has(payload)) {
    seenUnreadable.add(payload);
    console.log(`[enchants] unreadable record (${why}): ${payload}`);
  }
  return null;
}
function noteExtended(payload: string, rec: Buffer): void {
  if (seenExtended.size < DIAG_LIMIT && !seenExtended.has(payload)) {
    seenExtended.add(payload);
    console.log(`[enchants] extended record ${rec.length} bytes: ${rec.toString("hex")} (${payload})`);
  }
}
