// Composite wire structures shared by several packets.
import type { PacketReader } from "./reader";
import type { PacketWriter } from "./writer";
import { isKnownStat, isStringStat } from "./stats";

export interface WorldPos {
  x: number;
  y: number;
}
export const WorldPos = {
  read(r: PacketReader): WorldPos {
    const x = r.readFloat();
    const y = r.readFloat();
    return { x, y };
  },
  write(w: PacketWriter, p: WorldPos): void {
    w.writeFloat(p.x);
    w.writeFloat(p.y);
  },
  dist(a: WorldPos, b: WorldPos): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  },
};

export interface MoveRecord {
  time: number;
  pos: WorldPos;
}
export const MoveRecord = {
  read(r: PacketReader): MoveRecord {
    const time = r.readInt32();
    return { time, pos: WorldPos.read(r) };
  },
  write(w: PacketWriter, m: MoveRecord): void {
    w.writeInt32(m.time);
    WorldPos.write(w, m.pos);
  },
};

export interface StatData {
  statType: number;
  /** Numeric value; 0 for string stats. */
  statValue: number;
  /** String value; "" for numeric stats. */
  strStatValue: string;
  secondaryValue: number;
}
/** Stat types the game has that this decoder doesn't, logged once each: an
 *  unknown string-valued stat is what desyncs an UPDATE ("packet underflow"). */
const warnedStats = new Set<number>();
export const StatData = {
  read(r: PacketReader): StatData {
    const statType = r.readUnsignedByte();
    if (!isKnownStat(statType) && !warnedStats.has(statType)) {
      warnedStats.add(statType);
      console.log(`[stat] unknown stat type ${statType} at ${r.position} (${r.bytesAvailable()} bytes left), next bytes ${r.peekHex(12)} — add it to protocol/stats.ts, as a string stat if UPDATEs fail to parse`);
    }
    let statValue = 0;
    let strStatValue = "";
    if (isStringStat(statType)) strStatValue = r.readStr();
    else statValue = r.readCompressedInt();
    const secondaryValue = r.readCompressedInt();
    return { statType, statValue, strStatValue, secondaryValue };
  },
  write(w: PacketWriter, s: StatData): void {
    w.writeUnsignedByte(s.statType);
    if (isStringStat(s.statType)) w.writeStr(s.strStatValue);
    else w.writeCompressedInt(s.statValue);
    w.writeCompressedInt(s.secondaryValue);
  },
};

export interface ObjectStatus {
  objectId: number;
  pos: WorldPos;
  stats: StatData[];
}
export const ObjectStatus = {
  read(r: PacketReader): ObjectStatus {
    const objectId = r.readCompressedInt();
    const pos = WorldPos.read(r);
    const n = r.readCompressedInt();
    const stats: StatData[] = [];
    for (let i = 0; i < n; i++) stats.push(StatData.read(r));
    return { objectId, pos, stats };
  },
  write(w: PacketWriter, s: ObjectStatus): void {
    w.writeCompressedInt(s.objectId);
    WorldPos.write(w, s.pos);
    w.writeCompressedInt(s.stats.length);
    for (const st of s.stats) StatData.write(w, st);
  },
};

export interface ObjectData {
  objectType: number;
  status: ObjectStatus;
}
export const ObjectData = {
  read(r: PacketReader): ObjectData {
    const objectType = r.readUnsignedShort();
    return { objectType, status: ObjectStatus.read(r) };
  },
  write(w: PacketWriter, o: ObjectData): void {
    w.writeUnsignedShort(o.objectType);
    ObjectStatus.write(w, o.status);
  },
};

export interface GroundTile {
  x: number;
  y: number;
  type: number;
}
export const GroundTile = {
  read(r: PacketReader): GroundTile {
    const x = r.readShort();
    const y = r.readShort();
    const type = r.readUnsignedShort();
    return { x, y, type };
  },
  write(w: PacketWriter, t: GroundTile): void {
    w.writeShort(t.x);
    w.writeShort(t.y);
    w.writeUnsignedShort(t.type);
  },
};

export interface SlotObject {
  objectId: number;
  slotId: number;
  objectType: number;
}
export const SlotObject = {
  read(r: PacketReader): SlotObject {
    const objectId = r.readInt32();
    const slotId = r.readInt32();
    const objectType = r.readInt32();
    return { objectId, slotId, objectType };
  },
  write(w: PacketWriter, s: SlotObject): void {
    w.writeInt32(s.objectId);
    w.writeInt32(s.slotId);
    w.writeInt32(s.objectType);
  },
};

export interface TradeItem {
  /** Realm object type, -1 for an empty slot. */
  item: number;
  slotType: number;
  tradeable: boolean;
  included: boolean;
  /** Enchant record (see enchants.ts), "" when none. */
  enchantment: string;
}
export const TradeItem = {
  read(r: PacketReader): TradeItem {
    const item = r.readInt32();
    const slotType = r.readInt32();
    const tradeable = r.readBool();
    const included = r.readBool();
    const enchantment = r.readStr();
    return { item, slotType, tradeable, included, enchantment };
  },
  write(w: PacketWriter, t: TradeItem): void {
    w.writeInt32(t.item);
    w.writeInt32(t.slotType);
    w.writeBool(t.tradeable);
    w.writeBool(t.included);
    w.writeStr(t.enchantment);
  },
};

export interface FameBonus {
  name: string;
  rank: number;
  fame: number;
}
export const FameBonus = {
  read(r: PacketReader): FameBonus {
    const name = r.readStr();
    const rank = r.readCompressedInt();
    const fame = r.readCompressedInt();
    return { name, rank, fame };
  },
  write(w: PacketWriter, f: FameBonus): void {
    w.writeStr(f.name);
    w.writeCompressedInt(f.rank);
    w.writeCompressedInt(f.fame);
  },
};

function readList<T>(r: PacketReader, n: number, item: (r: PacketReader) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(item(r));
  return out;
}
export function readShortList<T>(r: PacketReader, item: (r: PacketReader) => T): T[] {
  return readList(r, r.readShort(), item);
}
export function readCompressedList<T>(r: PacketReader, item: (r: PacketReader) => T): T[] {
  return readList(r, r.readCompressedInt(), item);
}
export function readBoolMask(r: PacketReader): boolean[] {
  return readShortList(r, (rr) => rr.readBool());
}
export function writeBoolMask(w: PacketWriter, mask: boolean[]): void {
  w.writeShort(mask.length);
  for (const b of mask) w.writeBool(b);
}
