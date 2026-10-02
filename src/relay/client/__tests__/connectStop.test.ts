import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// A socket whose connect() resolves only when the test says so.
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  connected = false;
  closed = false;
  sent: string[] = [];
  release!: () => void;
  constructor() {
    super();
    sockets.push(this);
  }
  connect(): Promise<void> {
    return new Promise((res) => {
      this.release = () => {
        this.connected = true;
        res();
      };
    });
  }
  send(name: string) {
    this.sent.push(name);
  }
  close() {
    this.closed = true;
    this.connected = false;
  }
}
vi.mock("../../net/gameSocket", () => ({ GameSocket: FakeSocket }));

describe("connect() racing stop()", () => {
  it("closes the socket that finishes opening after stop() instead of adopting it", async () => {
    const { GameClient } = await import("../gameClient");
    const c = new GameClient({ guid: "a@b.c", password: "x", alias: "a" } as never);
    (c as unknown as { isReady: boolean }).isReady = true;
    (c as unknown as { host: string }).host = "127.0.0.1";
    const pending = c.connect();
    await Promise.resolve();
    const sock = sockets.at(-1)!;
    c.stop();
    sock.release();
    expect(await pending).toBe(false);
    expect(sock.closed).toBe(true);
    expect(c.connected).toBe(false);
  });
});
