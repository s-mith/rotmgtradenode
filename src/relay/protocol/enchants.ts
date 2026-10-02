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
/**
 * Entry values that are not enchantment ids. The stat pads its reserved
 * entries with 0xFFFD; the account snapshot's records (char/list with
 * muleDump, see decodeSnapshotRecord) end at 0xFFFD and mark a locked slot
 * 0xFFFE and an unlocked empty one 0xFFFF.
 */
const isSentinel = (id: number): boolean => id >= 0xfffd;
/**
 * The most enchantments a tradeable item carries. The game will not trade
 * an item with three (legendary) or four (divine): such an item is never
 * listed in the pool or communism and never picked for a trade.
 */
export const MAX_ENCHANTS = 2;
/** Whether an item with this many enchantments can change hands in game. */
export const tradeableEnchants = (count: number): boolean => count <= MAX_ENCHANTS;

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
    if (id === EMPTY) continue;
    if (!isSentinel(id)) out.push(id);
  }
  return out;
}

/**
 * An `ItemData` record from the account snapshot (char/list with
 * `muleDump=true`; docs/relay/STORAGE.md "The account snapshot"): base64,
 * URL-safe or standard, padded or not. The header is not checked: the
 * entries start at byte 3 either way (the stat's `00 02 04`, the snapshot's
 * `00` + item type), little-endian uint16 each, at most four, ending at
 * 0xFFFD; 0xFFFE (locked) and 0xFFFF (empty) are not enchantments. A record
 * too short to hold an entry decodes to [].
 */
export function decodeSnapshotRecord(payload: string): number[] {
  const body = payload.trim().replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!body || !/^[A-Za-z0-9+/]+$/.test(body)) return [];
  const rec = Buffer.from(body, "base64");
  const out: number[] = [];
  for (let i = 3; i + 1 < rec.length && out.length < 4; i += 2) {
    const id = rec.readUInt16LE(i);
    if (id === EMPTY) break;
    if (!isSentinel(id)) out.push(id);
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
