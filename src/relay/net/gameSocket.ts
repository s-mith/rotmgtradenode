// One TCP connection to a Realm game server: SOCKS or direct, RC4 in each
// direction, 5-byte framing, typed packet events.
//
// Timeouts match pyrelay: a SOCKS connect through a dead proxy would
// otherwise hang forever, and an in-world server never goes quiet for 30s.
import net from "node:net";
import { EventEmitter } from "node:events";
import { SocksClient } from "socks";
import { GAME_PORT } from "../realm/constants";
import type { Proxy } from "./proxy";
import { INCOMING_KEY, OUTGOING_KEY, RC4 } from "../protocol/rc4";
import { decodePayload, encodeFrame, HEADER_SIZE } from "../protocol/codec";
import type { AnyPacket, PacketName, Packets } from "../protocol/packets";

export const CONNECT_TIMEOUT_MS = 15_000;
export const READ_TIMEOUT_MS = 30_000;

export type CloseReason = "local" | "eof" | "reset" | "timeout" | "error";

/**
 * Observers of the raw wire traffic (rotmgnet's recorder): every decrypted frame in both
 * directions before decoding, plus the socket's open/close. Additive hook; nothing in the
 * relay registers one.
 */
export interface SocketTap {
  open?(sock: GameSocket): void;
  frame?(sock: GameSocket, dir: "in" | "out", id: number, payload: Buffer): void;
  close?(sock: GameSocket, reason: CloseReason, detail?: string): void;
}
export const socketTaps = new Set<SocketTap>();

export interface GameSocketEvents {
  packet: [pkt: AnyPacket];
  close: [reason: CloseReason, detail?: string];
  parseError: [id: number, err: unknown];
}

export class GameSocket extends EventEmitter<GameSocketEvents> {
  private sock: net.Socket | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private inbound = new RC4(INCOMING_KEY);
  private outbound = new RC4(OUTGOING_KEY);
  private closed = false;
  readonly host: string;

  readonly port: number;

  constructor(host: string, private readonly proxy: Proxy | null, port: number = GAME_PORT) {
    super();
    this.host = host;
    this.port = port;
  }

  get connected(): boolean {
    return this.sock !== null && !this.closed;
  }

  /** Open the connection. Rejects on connect failure; later failures emit `close`. */
  async connect(): Promise<void> {
    this.inbound.reset();
    this.outbound.reset();
    let sock: net.Socket;
    if (this.proxy) {
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: this.proxy.host,
          port: this.proxy.port,
          type: this.proxy.type,
          userId: this.proxy.username || undefined,
          password: this.proxy.password || undefined,
        },
        command: "connect",
        destination: { host: this.host, port: this.port },
        timeout: CONNECT_TIMEOUT_MS,
      });
      sock = socket;
    } else {
      sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host: this.host, port: this.port });
        const t = setTimeout(() => {
          s.destroy();
          reject(new Error(`connect timeout to ${this.host}`));
        }, CONNECT_TIMEOUT_MS);
        s.once("connect", () => {
          clearTimeout(t);
          resolve(s);
        });
        s.once("error", (e) => {
          clearTimeout(t);
          reject(e);
        });
      });
    }
    this.sock = sock;
    for (const t of socketTaps) t.open?.(this);
    sock.setNoDelay(true);
    sock.setTimeout(READ_TIMEOUT_MS);
    sock.on("data", (chunk: Buffer) => this.onData(chunk));
    sock.on("timeout", () => this.finish("timeout", `no data for ${READ_TIMEOUT_MS / 1000}s`));
    sock.on("end", () => this.finish("eof"));
    sock.on("error", (e: NodeJS.ErrnoException) => {
      this.finish(e.code === "ECONNRESET" ? "reset" : "error", e.message);
    });
    sock.on("close", () => this.finish("eof"));
  }

  send<K extends PacketName>(type: K, body: Packets[K]): boolean {
    if (!this.sock || this.closed) return false;
    const frame = encodeFrame(type, body);
    // Header stays plaintext; only the payload is enciphered.
    const payload = frame.subarray(HEADER_SIZE);
    if (socketTaps.size) for (const t of socketTaps) t.frame?.(this, "out", frame.readUInt8(4), Buffer.from(payload));
    this.outbound.process(payload);
    this.sock.write(frame);
    return true;
  }

  close(): void {
    this.finish("local");
  }

  private onData(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.pending.length < HEADER_SIZE) return;
      const size = this.pending.readInt32BE(0);
      if (size < HEADER_SIZE || size > 4 * 1024 * 1024) {
        this.finish("error", `bad frame size ${size}`);
        return;
      }
      if (this.pending.length < size) return;
      const id = this.pending.readUInt8(4);
      // Copy so the cipher doesn't mutate a slice of a buffer we may still
      // be reading from.
      const payload = Buffer.from(this.pending.subarray(HEADER_SIZE, size));
      this.pending = this.pending.subarray(size);
      this.inbound.process(payload);
      if (socketTaps.size) for (const t of socketTaps) t.frame?.(this, "in", id, payload);
      let pkt: AnyPacket;
      try {
        pkt = decodePayload(id, payload);
      } catch (e) {
        this.emit("parseError", id, e);
        continue;
      }
      this.emit("packet", pkt);
    }
  }

  private finish(reason: CloseReason, detail?: string): void {
    if (this.closed) return;
    this.closed = true;
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.removeAllListeners("data");
      s.destroy();
    }
    for (const t of socketTaps) t.close?.(this, reason, detail);
    this.emit("close", reason, detail);
  }
}
