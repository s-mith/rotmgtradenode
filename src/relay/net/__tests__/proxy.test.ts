// Pasted proxy lines in the shapes sellers hand them out, what the owner is
// told about each, and the check of a proxy against a local SOCKS5 server.
import { afterEach, describe, expect, it } from "vitest";
import { checkProxies, checkProxy, maskProxyLine, parseProxyList, parseProxyText, plainProxyError, readProxyLine, type Proxy, type ProxyCheckTargets } from "../proxy";
import { closedPort, fakeSocks, type FakeSocks } from "./fakeSocks";

const p = (host: string, port: number, username = "", password = "", type: 4 | 5 = 5): Proxy => ({ host, port, type, username, password });
const read = (line: string) => {
  const r = readProxyLine(line);
  return r.kind === "proxy" ? r.proxy : r;
};

describe("reading a pasted line", () => {
  it("takes every common shape", () => {
    expect(read("1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080));
    expect(read("1.2.3.4:1080:alice:s3cret")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("alice:s3cret@1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("1.2.3.4:1080@alice:s3cret")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("alice:s3cret:1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("socks5://alice:s3cret@proxy.example.com:1080/")).toEqual(p("proxy.example.com", 1080, "alice", "s3cret"));
    expect(read("socks5h://1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080));
    expect(read("SOCKS://1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080));
    expect(read("socks4://1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080, "", "", 4));
    expect(read("socks4a://1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080, "", "", 4));
    // The old file format: the scheme without its slashes.
    expect(read("socks5:1.2.3.4:1080:alice:s3cret")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("socks4:1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080, "", "", 4));
    // Spaces, tabs, commas and semicolons between the parts.
    expect(read("1.2.3.4 1080 alice s3cret")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("1.2.3.4\t1080\talice\ts3cret")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("1.2.3.4,1080,alice,s3cret")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
    expect(read("1.2.3.4;1080")).toEqual(p("1.2.3.4", 1080));
    // Passwords with the separators in them.
    expect(read("1.2.3.4:1080:alice:pa:ss")).toEqual(p("1.2.3.4", 1080, "alice", "pa:ss"));
    expect(read("alice:p@ss:word@1.2.3.4:1080")).toEqual(p("1.2.3.4", 1080, "alice", "p@ss:word"));
    // A note after the line.
    expect(read("  1.2.3.4:1080:alice:s3cret   # the Frankfurt one")).toEqual(p("1.2.3.4", 1080, "alice", "s3cret"));
  });

  it("skips blanks and comments", () => {
    for (const l of ["", "   ", "# my proxies", "// list", "; ini style"]) expect(readProxyLine(l)).toEqual({ kind: "skip" });
  });

  it("keeps an http:// line, spoken to as SOCKS5, with a note", () => {
    const r = readProxyLine("http://alice:s3cret@1.2.3.4:8080");
    expect(r).toMatchObject({ kind: "proxy", proxy: p("1.2.3.4", 8080, "alice", "s3cret"), note: expect.stringMatching(/HTTP proxy/) });
  });

  it("says in plain words why a line can't be used", () => {
    expect(readProxyLine("1.2.3.4:1080:alice")).toEqual({ kind: "error", error: expect.stringMatching(/username but no password/) });
    expect(readProxyLine("1.2.3.4:99999")).toEqual({ kind: "error", error: expect.stringMatching(/port must be a number from 1 to 65535/) });
    expect(readProxyLine("1.2.3.4:0")).toEqual({ kind: "error", error: expect.stringMatching(/port must be/) });
    expect(readProxyLine("not a proxy at all")).toEqual({ kind: "error", error: expect.stringMatching(/^Couldn't read this line/) });
    // Three words are not a host, a port and a username.
    expect(readProxyLine("not a proxy")).toEqual({ kind: "error", error: expect.stringMatching(/^Couldn't read this line/) });
    expect(readProxyLine("bad_host!:1080")).toEqual({ kind: "error", error: expect.stringMatching(/doesn't look like a proxy address/) });
    expect(readProxyLine("ftp://1.2.3.4:21")).toEqual({ kind: "error", error: expect.stringMatching(/can't use “ftp” proxies/) });
    expect(readProxyLine("alice:@1.2.3.4:1080")).toEqual({ kind: "error", error: expect.stringMatching(/username but no password/) });
  });
});

describe("a pasted list", () => {
  it("reports each line, drops duplicates, and never echoes a password", () => {
    const text = [
      "# my list",
      "1.2.3.4:1080:alice:s3cretpw",
      "",
      "5.6.7.8:1080",
      "1.2.3.4:1080:alice:s3cretpw",
      "9.9.9.9:1080:bob",
      "bob:hunter22@nowhere:abc",
      "http://4.4.4.4:8080",
    ].join("\r\n");
    const { lines, proxies } = parseProxyText(text);
    expect(proxies).toEqual([p("1.2.3.4", 1080, "alice", "s3cretpw"), p("5.6.7.8", 1080), p("4.4.4.4", 8080)]);
    expect(lines).toEqual([
      { line: 2, ok: true, display: "1.2.3.4:1080", type: "socks5" },
      { line: 4, ok: true, display: "5.6.7.8:1080", type: "socks5" },
      { line: 5, ok: false, raw: "1.2.3.4:1080:••••:••••", error: "Same proxy as line 2, so it is skipped.", skipped: true },
      { line: 6, ok: false, raw: "9.9.9.9:1080:••••", error: expect.stringMatching(/username but no password/) },
      { line: 7, ok: false, raw: expect.any(String), error: expect.any(String) },
      { line: 8, ok: true, display: "4.4.4.4:8080", type: "socks5", note: expect.stringMatching(/HTTP/) },
    ]);
    const shown = JSON.stringify(lines);
    for (const secret of ["s3cretpw", "hunter22", "alice", "bob"]) expect(shown).not.toContain(secret);
    // The old reader gives the same proxies.
    expect(parseProxyList(text)).toEqual(proxies);
  });

  it("masks everything that isn't an address or a port", () => {
    expect(maskProxyLine("alice:s3cret@1.2.3.4:1080")).toBe("••••:••••@1.2.3.4:1080");
    expect(maskProxyLine("socks5://alice:s3cret@proxy.example.com:1080")).toBe("socks5://••••:••••@proxy.example.com:1080");
    expect(maskProxyLine("1.2.3.4 1080 alice s3cret")).toBe("1.2.3.4 1080 •••• ••••");
  });
});

describe("what went wrong with a proxy, in words", () => {
  it("maps the SOCKS library's errors", () => {
    expect(plainProxyError(new Error("Socks5 Authentication failed"), "web")).toBe("Wrong proxy username or password.");
    expect(plainProxyError(new Error("Received invalid Socks5 initial handshake (no accepted authentication type)"), "web")).toMatch(/wants a username and password/);
    expect(plainProxyError(new Error("Socks5 proxy rejected connection - NotAllowed"), "web")).toMatch(/won't connect to Realm's website/);
    expect(plainProxyError(new Error("Socks5 proxy rejected connection - NotAllowed"), "game")).toMatch(/blocks the game/);
    expect(plainProxyError(new Error("Proxy connection timed out"), "web")).toMatch(/didn't answer in time/);
    expect(plainProxyError(Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:1080"), { code: "ECONNREFUSED" }), "web")).toMatch(/^Could not reach the proxy\. Check the address/);
    expect(plainProxyError(new Error("Received invalid Socks5 initial handshake (invalid socks version)"), "web")).toMatch(/didn't answer like a SOCKS5 proxy/);
    expect(plainProxyError(new Error("something else"), "web")).toBe("The proxy didn't work.");
  });
});

describe("checking a proxy", () => {
  const servers: FakeSocks[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });
  const targets = (o: Partial<ProxyCheckTargets> = {}): ProxyCheckTargets => ({ web: { host: "www.realmofthemadgod.com", port: 443 }, game: { host: "52.207.206.31", port: 2050 }, timeoutMs: 3000, slowMs: 2500, ...o });
  const start = async (o: Parameters<typeof fakeSocks>[0] = {}) => {
    const s = await fakeSocks(o);
    servers.push(s);
    return s;
  };

  it("logs in, then reaches Realm's website and a game server through it", async () => {
    const s = await start({ auth: { username: "alice", password: "s3cret" } });
    const r = await checkProxy(p("127.0.0.1", s.port, "alice", "s3cret"), targets());
    expect(r).toMatchObject({ host: `127.0.0.1:${s.port}`, ok: true, ms: expect.any(Number) });
    expect(s.connects).toEqual([{ host: "www.realmofthemadgod.com", port: 443 }, { host: "52.207.206.31", port: 2050 }]);
  });

  it("says when the login is wrong, or missing", async () => {
    const s = await start({ auth: { username: "alice", password: "s3cret" } });
    expect(await checkProxy(p("127.0.0.1", s.port, "alice", "nope"), targets())).toMatchObject({ ok: false, error: "Wrong proxy username or password." });
    expect(await checkProxy(p("127.0.0.1", s.port), targets())).toMatchObject({ ok: false, error: expect.stringMatching(/wants a username and password/) });
  });

  it("says when the proxy blocks the game", async () => {
    const s = await start({ blockPort: 2050 });
    expect(await checkProxy(p("127.0.0.1", s.port), targets())).toMatchObject({ ok: false, error: expect.stringMatching(/blocks the game/) });
  });

  it("says when nothing answers, or not in time, or not as SOCKS5", async () => {
    expect(await checkProxy(p("127.0.0.1", await closedPort()), targets())).toMatchObject({ ok: false, error: expect.stringMatching(/^Could not reach the proxy\. Check the address/) });
    const silent = await start({ silent: true });
    const t0 = Date.now();
    expect(await checkProxy(p("127.0.0.1", silent.port), targets({ timeoutMs: 300 }))).toMatchObject({ ok: false, error: expect.stringMatching(/didn't answer in time/) });
    expect(Date.now() - t0).toBeLessThan(2000);
    const web = await start({ http: true });
    expect(await checkProxy(p("127.0.0.1", web.port), targets())).toMatchObject({ ok: false, error: expect.stringMatching(/didn't answer like a SOCKS5 proxy/) });
  });

  it("calls a slow proxy too slow", async () => {
    const s = await start({ delayMs: 60 });
    const r = await checkProxy(p("127.0.0.1", s.port), targets({ slowMs: 100 }));
    expect(r).toMatchObject({ ok: false, ms: expect.any(Number), error: expect.stringMatching(/^Too slow: it took \d+\.\d s to answer/) });
  });

  it("checks several, four at a time, answering in the order given", async () => {
    // A check is under way from its first CONNECT (the website) to its last (the game server).
    let inFlight = 0;
    let most = 0;
    const s = await start({
      delayMs: 40,
      onConnect: (_h, port) => {
        if (port === 443) most = Math.max(most, ++inFlight);
        else inFlight--;
      },
    });
    const list = Array.from({ length: 7 }, () => p("127.0.0.1", s.port));
    const dead = p("127.0.0.1", await closedPort());
    const r = await checkProxies([...list.slice(0, 3), dead, ...list.slice(3)], targets(), 4);
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false, true, true, true, true]);
    expect(most).toBe(4);
    expect(await checkProxies([], targets())).toEqual([]);
  });
});
