// What the diagnostics text takes out before an owner shares it.
import { describe, expect, it } from "vitest";
import { accountLabels, maskEmail, maskHost, redact, relabel } from "../diagnostics";

describe("masking", () => {
  it("keeps the first letter and the domain of an email", () => {
    expect(maskEmail("abcdef@hotmail.com")).toBe("a***@hotmail.com");
    expect(maskEmail("x@y.io")).toBe("x***@y.io");
    expect(maskEmail("no-at-sign")).toBe("***");
  });
  it("keeps half an address and the port", () => {
    expect(maskHost("45.67.89.10:5646")).toBe("45.67.x.x:5646");
    expect(maskHost("45.67.89.10")).toBe("45.67.x.x");
    expect(maskHost("proxy.example.com:1080")).toBe("p***.example.com:1080");
    expect(maskHost("localhost")).toBe("l***");
  });
});

describe("redact", () => {
  it("takes out the secrets it is given, as whole words only", () => {
    expect(redact("login with hunter2pw failed; hunter2pwx is not it", ["hunter2pw"])).toBe("login with [hidden] failed; hunter2pwx is not it");
    // Too short to tell from ordinary words: left alone.
    expect(redact("a b pw", ["pw"])).toBe("a b pw");
  });
  it("takes out emails, addresses, and logins in URLs and proxy lines", () => {
    expect(redact("account bot1@example.com logged in")).toBe("account b***@example.com logged in");
    expect(redact("via 45.67.89.10:5646")).toBe("via 45.67.x.x:5646");
    expect(redact("reached 45.67.89.10.")).toBe("reached 45.67.x.x.");
    // Version numbers are not addresses.
    expect(redact("Realm build 7.0.0.2.0, app 1.2.3.4.5")).toBe("Realm build 7.0.0.2.0, app 1.2.3.4.5");
    expect(redact("socks5h://alice:s3cret@proxy.example.com:1080")).toBe("socks5h://[hidden]@proxy.example.com:1080");
    expect(redact("line 45.67.89.10:5646:alice:s3cret was bad")).toBe("line 45.67.x.x:5646:[hidden] was bad");
    expect(redact("gw.example.net:7000:user-1:pa:ss")).toBe("gw.example.net:7000:[hidden]");
  });
  it("takes out passwords, tokens, codes and session ids", () => {
    expect(redact('password=abc123 token: zzz "secret":"shh" sessionid=f00')).toBe('password=[hidden] token: [hidden] "secret":"[hidden]" sessionid=[hidden]');
    expect(redact("GET /char/list?accessToken=AAAA&guid=b%40c.d")).toBe("GET /char/list?accessToken=[hidden]&guid=[hidden]");
    expect(redact("queued /tell Someone XK29QP")).toBe("queued /tell Someone [hidden]");
    expect(redact("link code: ABCD-1234 used")).toBe("link code: [hidden] used");
    expect(redact("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here")).toBe("jwt [token] here");
    expect(redact(`id ${"ab12".repeat(10)} end`)).toBe("id [id] end");
    expect(redact(`tok ${"Zx9_".repeat(12)} end`)).toBe("tok [token] end");
  });
  it("leaves ordinary log lines readable", () => {
    const line = "sweep: TipSticky captured 8 item(s), cap 16 (backpack) on USSouth3 after 12.5s; TRADEDONE code 0";
    expect(redact(line)).toBe(line);
  });
  it("takes the computer's user folder out of paths", () => {
    expect(redact("ProxyPool: failed to read C:\\Users\\Owner\\AppData\\Roaming\\rotmgtrade\\proxies.txt")).toBe("ProxyPool: failed to read C:\\Users\\[you]\\AppData\\Roaming\\rotmgtrade\\proxies.txt");
    expect(redact('{"dir":"C:\\\\Users\\\\johns\\\\AppData"}')).toBe('{"dir":"C:\\\\Users\\\\[you]\\\\AppData"}');
    expect(redact("data in /home/lily/rotmgtrade and /Users/Kim/Library")).toBe("data in /home/[you]/rotmgtrade and /Users/[you]/Library");
  });
});

describe("account labels", () => {
  const roster = [
    { alias: "bob123", guid: "Bob123@hotmail.com" },
    { alias: "Main trader", guid: "kim@example.com" },
    { alias: "zed@mail.com", guid: "zed@mail.com" },
  ];
  it("renames only the aliases that spell out a login", () => {
    expect([...accountLabels(roster)]).toEqual([["bob123", "account 1"], ["zed@mail.com", "account 3"]]);
  });
  it("relabels them everywhere, after the emails are masked", () => {
    const text = redact("sweep: waking bob123 (1/2); Bob123@hotmail.com connected; Main trader idle; bob1234 is someone else", []);
    expect(relabel(text, accountLabels(roster))).toBe("sweep: waking account 1 (1/2); B***@hotmail.com connected; Main trader idle; bob1234 is someone else");
  });
});
