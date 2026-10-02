// Where the character stands (inNexus / inVault): only once its CREATE_SUCCESS
// has come after the map's MAPINFO, never on gameIdValue's say-so; and
// escapeToNexus, which keeps sending ESCAPE until the bot is back.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  connected = false;
  sent: string[] = [];
  constructor() {
    super();
    sockets.push(this);
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  send(name: string) {
    this.sent.push(name);
    return true;
  }
  close() {
    this.connected = false;
  }
}
vi.mock("../../net/gameSocket", () => ({ GameSocket: FakeSocket }));

const { GameClient } = await import("../gameClient");
const { GameId } = await import("../../realm/constants");
type Client = InstanceType<typeof GameClient>;

async function connected(): Promise<{ c: Client; sock: () => FakeSocket }> {
  const c = new GameClient({ guid: "a@b.c", password: "x", alias: "a" } as never);
  c.adoptSession({ accessToken: "tok", charId: 3 });
  (c as unknown as { host: string }).host = "127.0.0.1";
  expect(await c.connect()).toBe(true);
  return { c, sock: () => sockets.at(-1)! };
}
const mapInfo = (s: FakeSocket, name: string) => s.emit("packet", { type: "MAPINFO", name });
const created = (s: FakeSocket, objectId = 7) => s.emit("packet", { type: "CREATESUCCESS", objectId, charId: 3 });
const escapes = (s: FakeSocket) => s.sent.filter((n) => n === "ESCAPE").length;

beforeEach(() => {
  sockets.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("inNexus / inVault", () => {
  it("are true only once CREATE_SUCCESS has come for the map", async () => {
    const { c, sock } = await connected();
    expect(c.gameIdValue).toBe(GameId.nexus);
    expect(c.inNexus()).toBe(false); // the HELLO asked for the Nexus; nothing is loaded yet
    mapInfo(sock(), "Nexus");
    expect(c.inNexus()).toBe(false);
    created(sock());
    expect(c.inNexus()).toBe(true);
    expect(c.inVault()).toBe(false);
    c.stop();
  });
  it("say neither while the next map loads, though the objectId is the old map's", async () => {
    const { c, sock } = await connected();
    mapInfo(sock(), "Vault");
    created(sock(), 7);
    expect(c.inVault()).toBe(true);
    // ESCAPE: gameIdValue says Nexus at once, but the bot is still in the Vault until the reconnect lands.
    c.nexus();
    expect(c.gameIdValue).toBe(GameId.nexus);
    expect(c.inNexus()).toBe(false);
    expect(c.inVault()).toBe(true);
    sock().emit("packet", { type: "RECONNECT", host: "", gameId: GameId.nexus, key: new Uint8Array(0), keyTime: -1, name: "Nexus", port: 2050, stats: "" });
    expect(c.inVault()).toBe(false);
    await vi.waitFor(() => expect(sockets.length === 2 && c.connected).toBe(true));
    mapInfo(sock(), "Nexus");
    expect(c.objectId).toBe(7);
    expect(c.inNexus()).toBe(false);
    created(sock(), 9);
    expect(c.inNexus()).toBe(true);
    c.stop();
  });
  it("are false once the socket closes or the client stops", async () => {
    const { c, sock } = await connected();
    mapInfo(sock(), "Nexus");
    created(sock());
    sock().emit("close", "remote");
    expect(c.inNexus()).toBe(false);
    const again = await connected();
    mapInfo(again.sock(), "Nexus");
    created(again.sock());
    again.c.disconnect();
    expect(again.c.inNexus()).toBe(false);
    c.stop();
    again.c.stop();
  });
});

describe("escapeToNexus", () => {
  it("sends ESCAPE, then again every 3 s while the bot is elsewhere, up to 4 more times", async () => {
    const { c, sock } = await connected();
    mapInfo(sock(), "Vault");
    created(sock());
    vi.useFakeTimers();
    c.escapeToNexus();
    expect(escapes(sock())).toBe(1);
    c.escapeToNexus(); // already on its way: no second loop, no second ESCAPE
    expect(escapes(sock())).toBe(1);
    vi.advanceTimersByTime(3_000);
    expect(escapes(sock())).toBe(2);
    vi.advanceTimersByTime(3_000 * 10);
    expect(escapes(sock())).toBe(5);
    c.stop();
  });
  it("stops once the bot stands in the Nexus", async () => {
    const { c, sock } = await connected();
    mapInfo(sock(), "Vault");
    created(sock());
    vi.useFakeTimers();
    c.escapeToNexus();
    // The answer landed on this socket in this test: the Nexus loads.
    mapInfo(sock(), "Nexus");
    vi.advanceTimersByTime(3_000);
    expect(escapes(sock())).toBe(1); // loading: no character to move, nothing sent
    created(sock());
    vi.advanceTimersByTime(3_000 * 10);
    expect(escapes(sock())).toBe(1);
    expect(c.inNexus()).toBe(true);
    c.stop();
  });
  it("does nothing in the Nexus, and waits for a loading map before sending", async () => {
    const { c, sock } = await connected();
    mapInfo(sock(), "Nexus");
    created(sock());
    c.escapeToNexus();
    expect(escapes(sock())).toBe(0);
    mapInfo(sock(), "Vault"); // on its way into the Vault
    vi.useFakeTimers();
    c.escapeToNexus();
    expect(escapes(sock())).toBe(0);
    created(sock());
    vi.advanceTimersByTime(3_000);
    expect(escapes(sock())).toBe(1);
    c.stop();
  });
  it("stops with the client", async () => {
    const { c, sock } = await connected();
    mapInfo(sock(), "Vault");
    created(sock());
    vi.useFakeTimers();
    c.escapeToNexus();
    c.stop();
    vi.advanceTimersByTime(3_000 * 10);
    expect(escapes(sock())).toBe(1);
  });
});

describe("a kept token the game server refuses", () => {
  it("FAILURE 11 with no text on a resumed session is a spent token; on a minted one it is what it always was", async () => {
    const failures: { kind: string }[] = [];
    // A session on a kept token (resume): the game refuses it at LOAD.
    const kept = await connected();
    (kept.c as unknown as { tokenReused: boolean }).tokenReused = true;
    kept.c.on("failure", (f: { kind: string }) => failures.push(f));
    kept.sock().emit("packet", { type: "FAILURE", errorId: 11, errorDescription: "" });
    expect(failures).toEqual([{ kind: "token-error", errorId: 11 }]);
    expect(kept.c.active).toBe(false);
    // The same answer on a token minted for the session is left as before: not a token error.
    failures.length = 0;
    const minted = await connected();
    minted.c.on("failure", (f: { kind: string }) => failures.push(f));
    minted.sock().emit("packet", { type: "FAILURE", errorId: 11, errorDescription: "" });
    expect(failures).toEqual([{ kind: "other", errorId: 11, description: "" }]);
    minted.c.stop();
  });
});
