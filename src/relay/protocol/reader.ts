// Big-endian packet reader over one packet's payload (header already
// stripped). Mirrors the Python Reader so both sides parse identically.
export class PacketReader {
  private index = 0;
  constructor(private readonly buf: Buffer) {}

  get position(): number {
    return this.index;
  }
  bytesAvailable(): number {
    return this.buf.length - this.index;
  }
  /** The next bytes as hex, without consuming them (diagnostics). */
  peekHex(n: number): string {
    return this.buf.subarray(this.index, Math.min(this.buf.length, this.index + n)).toString("hex");
  }
  private need(n: number): void {
    if (this.index + n > this.buf.length) {
      throw new RangeError(`packet underflow: need ${n} at ${this.index} of ${this.buf.length}`);
    }
  }
  readByte(): number {
    this.need(1);
    return this.buf.readInt8(this.index++);
  }
  readUnsignedByte(): number {
    this.need(1);
    return this.buf.readUInt8(this.index++);
  }
  readInt32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.index);
    this.index += 4;
    return v;
  }
  readUInt32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.index);
    this.index += 4;
    return v;
  }
  readFloat(): number {
    this.need(4);
    const v = this.buf.readFloatBE(this.index);
    this.index += 4;
    return v;
  }
  readShort(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.index);
    this.index += 2;
    return v;
  }
  readUnsignedShort(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.index);
    this.index += 2;
    return v;
  }
  readBool(): boolean {
    return this.readUnsignedByte() !== 0;
  }
  readStr(): string {
    const len = this.readShort();
    this.need(len);
    const s = this.buf.toString("utf8", this.index, this.index + len);
    this.index += len;
    return s;
  }
  readStr32(): string {
    const len = this.readInt32();
    this.need(len);
    const s = this.buf.toString("utf8", this.index, this.index + len);
    this.index += len;
    return s;
  }
  /** Short-prefixed byte array (the HELLO/RECONNECT key). */
  readBytes(): Buffer {
    const len = this.readShort();
    this.need(len);
    const out = Buffer.from(this.buf.subarray(this.index, this.index + len));
    this.index += len;
    return out;
  }
  /** Realm's variable-length int: 6 bits + sign in the first byte, 7 per byte after. */
  readCompressedInt(): number {
    let b = this.readUnsignedByte();
    const negative = (b & 64) !== 0;
    let shift = 6;
    let value = b & 63;
    while (b & 128) {
      b = this.readUnsignedByte();
      value |= (b & 127) << shift;
      shift += 7;
    }
    return negative ? -value : value;
  }
  /** Raw peek for diagnostics. */
  peek(n: number): Buffer {
    return this.buf.subarray(this.index, this.index + n);
  }
}
