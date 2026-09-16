// RC4 stream cipher as Realm uses it on the game socket: one keystream per
// direction, reset on every new connection. Keys are the well-known client
// constants (they are not secrets; every client ships them).
export const OUTGOING_KEY = "5a4d2016bc16dc64883194ffd9";
export const INCOMING_KEY = "c91d9eec420160730d825604e0";

export class RC4 {
  private readonly key: Uint8Array;
  private state = new Uint8Array(256);
  private x = 0;
  private y = 0;

  constructor(keyHex: string) {
    this.key = Uint8Array.from(Buffer.from(keyHex, "hex"));
    this.reset();
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    for (let i = 0; i < 256; i++) this.state[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + this.state[i] + this.key[i % this.key.length]) & 0xff;
      const t = this.state[i];
      this.state[i] = this.state[j];
      this.state[j] = t;
    }
  }

  /** XOR `data` in place with the keystream and return it. */
  process(data: Uint8Array): Uint8Array {
    const s = this.state;
    for (let i = 0; i < data.length; i++) {
      this.x = (this.x + 1) & 0xff;
      this.y = (this.y + s[this.x]) & 0xff;
      const t = s[this.x];
      s[this.x] = s[this.y];
      s[this.y] = t;
      data[i] ^= s[(s[this.x] + s[this.y]) & 0xff];
    }
    return data;
  }
}
