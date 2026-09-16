// Big-endian packet writer. Produces the payload; `frame()` prepends the
// 5-byte header (int32 total length, uint8 packet id).
export class PacketWriter {
  private chunks: Buffer[] = [];
  private length = 0;

  private push(b: Buffer): void {
    this.chunks.push(b);
    this.length += b.length;
  }
  writeByte(v: number): void {
    const b = Buffer.alloc(1);
    b.writeInt8(v);
    this.push(b);
  }
  writeUnsignedByte(v: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.push(b);
  }
  writeInt32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.push(b);
  }
  writeUInt32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.push(b);
  }
  writeFloat(v: number): void {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    this.push(b);
  }
  writeShort(v: number): void {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.push(b);
  }
  writeUnsignedShort(v: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    this.push(b);
  }
  writeBool(v: boolean): void {
    this.writeUnsignedByte(v ? 1 : 0);
  }
  writeStr(s: string): void {
    const b = Buffer.from(s, "utf8");
    this.writeShort(b.length);
    this.push(b);
  }
  writeStr32(s: string): void {
    const b = Buffer.from(s, "utf8");
    this.writeInt32(b.length);
    this.push(b);
  }
  writeBytes(bytes: Uint8Array): void {
    this.writeShort(bytes.length);
    this.push(Buffer.from(bytes));
  }
  writeCompressedInt(value: number): void {
    let b = 0;
    if (value < 0) b |= 64;
    value = Math.abs(value);
    b |= value & 63;
    value >>>= 6;
    if (value > 0) b |= 128;
    this.writeUnsignedByte(b);
    while (value > 0) {
      b = value & 127;
      value >>>= 7;
      if (value > 0) b |= 128;
      this.writeUnsignedByte(b);
    }
  }
  /** The payload written so far. */
  payload(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
  /** Header + payload, ready for the socket (before RC4). */
  frame(packetId: number): Buffer {
    const header = Buffer.alloc(5);
    header.writeInt32BE(this.length + 5, 0);
    header.writeUInt8(packetId, 4);
    return Buffer.concat([header, ...this.chunks], this.length + 5);
  }
}
