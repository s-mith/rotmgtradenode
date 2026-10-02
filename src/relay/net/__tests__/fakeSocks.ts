// A SOCKS5 proxy on 127.0.0.1 for tests: the greeting, the username and
// password, and CONNECT, answered without connecting anywhere. It can want a
// login, refuse one port (a proxy that blocks the game), answer slowly, not
// answer at all, or answer like an HTTP server.
import net from "node:net";

export interface FakeSocksOptions {
  /** The login the proxy wants; none: no login. */
  auth?: { username: string; password: string };
  /** CONNECTs to this port are refused ("not allowed by ruleset"). */
  blockPort?: number;
  /** Wait this long before every reply. */
  delayMs?: number;
  /** Take the connection and never say a word. */
  silent?: boolean;
  /** Answer like a web server. */
  http?: boolean;
  /** Told of every CONNECT as it arrives. */
  onConnect?: (host: string, port: number) => void;
}

export interface FakeSocks {
  port: number;
  /** Every CONNECT asked for, in order. */
  connects: { host: string; port: number }[];
  /** The most connections open at once. */
  maxOpen: () => number;
  close: () => Promise<void>;
}

export async function fakeSocks(o: FakeSocksOptions = {}): Promise<FakeSocks> {
  let open = 0;
  let maxOpen = 0;
  const connects: { host: string; port: number }[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    open++;
    maxOpen = Math.max(maxOpen, open);
    sock.on("close", () => {
      sockets.delete(sock);
      open--;
    });
    sock.on("error", () => {});
    if (o.silent) return;
    let buf = Buffer.alloc(0);
    let stage: "greet" | "auth" | "request" | "done" = "greet";
    const later = (f: () => void) => (o.delayMs ? setTimeout(f, o.delayMs) : f());
    sock.on("data", (d: Buffer) => {
      if (o.http) {
        sock.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === "greet") {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + buf[1]);
          const want = o.auth ? 0x02 : 0x00;
          if (!methods.includes(want)) {
            stage = "done";
            later(() => sock.end(Buffer.from([5, 0xff])));
            return;
          }
          stage = o.auth ? "auth" : "request";
          later(() => sock.write(Buffer.from([5, want])));
          continue;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 3 + ulen) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString();
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          const ok = user === o.auth!.username && pass === o.auth!.password;
          if (!ok) {
            stage = "done";
            later(() => sock.end(Buffer.from([1, 1])));
            return;
          }
          stage = "request";
          later(() => sock.write(Buffer.from([1, 0])));
          continue;
        }
        if (stage === "request") {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let len: number;
          let host: string;
          if (atyp === 1) {
            len = 10;
            if (buf.length < len) return;
            host = [...buf.subarray(4, 8)].join(".");
          } else if (atyp === 3) {
            len = 5 + buf[4] + 2;
            if (buf.length < len) return;
            host = buf.subarray(5, 5 + buf[4]).toString();
          } else {
            sock.destroy();
            return;
          }
          const port = buf.readUInt16BE(len - 2);
          buf = buf.subarray(len);
          connects.push({ host, port });
          o.onConnect?.(host, port);
          stage = "done";
          const refused = o.blockPort === port;
          later(() => {
            sock.write(Buffer.from([5, refused ? 0x02 : 0x00, 0, 1, 127, 0, 0, 1, 0, 80]));
            if (refused) sock.end();
          });
        }
        return;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, connects, maxOpen: () => maxOpen,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

/** A port on 127.0.0.1 nothing listens on. */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
