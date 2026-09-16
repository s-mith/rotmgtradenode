// Frame-level encode/decode: packet object <-> header+payload bytes.
import { PACKET_ID_TO_NAME, PACKET_NAME_TO_ID } from "./packetIds";
import { PacketReader } from "./reader";
import { PacketWriter } from "./writer";
import { CODECS, isKnownPacket, type AnyPacket, type Packet, type PacketName, type Packets } from "./packets";

export const HEADER_SIZE = 5;

/** Encode a packet into a full frame (5-byte header + payload), unencrypted. */
export function encodeFrame<K extends PacketName>(type: K, body: Packets[K]): Buffer {
  const id = PACKET_NAME_TO_ID[type];
  if (id === undefined) throw new Error(`no wire id for packet ${type}`);
  const w = new PacketWriter();
  CODECS[type].write(w, body);
  return w.frame(id);
}

/** Decode a packet's payload (header already consumed) by wire id. */
export function decodePayload(id: number, payload: Buffer): AnyPacket {
  const name = PACKET_ID_TO_NAME[id];
  if (!name || !isKnownPacket(name)) return { type: "UNKNOWN", id, payload };
  const body = CODECS[name].read(new PacketReader(payload));
  return { type: name, ...body } as Packet;
}
