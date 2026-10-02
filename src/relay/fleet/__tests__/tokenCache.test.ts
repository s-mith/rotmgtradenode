// The kept access tokens of advanced accounts (tokenCache.ts) and the
// lifetime account/verify gives a token (realm/api.ts).
import { describe, expect, it } from "vitest";
import { exitKey, TOKEN_REUSE_MAX_S, TokenCache } from "../tokenCache";
import { tokenLifetimeFrom } from "../../realm/api";

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("TokenCache", () => {
  it("hands a token out again through the exit that minted it, until its time is up", () => {
    const c = clock();
    const cache = new TokenCache(c.now);
    cache.set("a@x", "1.1.1.1:1080", "tok", c.now(), null);
    expect(cache.get("a@x", "1.1.1.1:1080")).toMatchObject({ token: "tok", issuedAt: 1_000_000 });
    expect(cache.get("a@x", "2.2.2.2:1080")).toBeNull();
    expect(cache.get("b@x", "1.1.1.1:1080")).toBeNull();
    c.advance(TOKEN_REUSE_MAX_S * 1000 - 1);
    expect(cache.get("a@x", "1.1.1.1:1080")?.token).toBe("tok");
    c.advance(1);
    expect(cache.get("a@x", "1.1.1.1:1080")).toBeNull();
    expect(cache.size).toBe(0);
  });
  it("keeps a token no longer than Realm says it lasts, less a margin", () => {
    const c = clock();
    const cache = new TokenCache(c.now);
    cache.set("a@x", "direct", "short", c.now(), 300);
    c.advance(239_000);
    expect(cache.get("a@x", "direct")?.token).toBe("short");
    c.advance(1_000);
    expect(cache.get("a@x", "direct")).toBeNull();
    // A lifetime inside the margin is not worth keeping at all.
    cache.set("a@x", "direct", "spent", c.now(), 30);
    expect(cache.get("a@x", "direct")).toBeNull();
  });
  it("keeps one token per account: a mint through another exit replaces the last", () => {
    const cache = new TokenCache();
    cache.set("a@x", "1.1.1.1:1080", "one", Date.now(), null);
    cache.set("a@x", "2.2.2.2:1080", "two", Date.now(), null);
    expect(cache.get("a@x", "1.1.1.1:1080")).toBeNull();
    expect(cache.get("a@x", "2.2.2.2:1080")?.token).toBe("two");
  });
  it("forgets an account's token on invalidate, and only that account's", () => {
    const cache = new TokenCache();
    cache.set("a@x", "direct", "ta", Date.now(), null);
    cache.set("a@xy", "direct", "tb", Date.now(), null);
    cache.invalidate("a@x");
    expect(cache.get("a@x", "direct")).toBeNull();
    expect(cache.get("a@xy", "direct")?.token).toBe("tb");
  });
  it("never keeps an empty token", () => {
    const cache = new TokenCache();
    cache.set("a@x", "direct", "", Date.now(), null);
    expect(cache.size).toBe(0);
  });
  it("keys an exit by the proxy's host and port, or this computer's own IP", () => {
    expect(exitKey({ host: "1.1.1.1", port: 1080 })).toBe("1.1.1.1:1080");
    expect(exitKey(null)).toBe("direct");
  });
});

describe("tokenLifetimeFrom", () => {
  it("reads AccessTokenExpiration as seconds to live, or what is left of an epoch time", () => {
    expect(tokenLifetimeFrom("<Account><AccessToken>t</AccessToken><AccessTokenExpiration>3600</AccessTokenExpiration></Account>")).toBe(3600);
    expect(tokenLifetimeFrom("<AccessTokenExpiration>2000000600</AccessTokenExpiration>", 2_000_000_000_000)).toBe(600);
    expect(tokenLifetimeFrom("<AccessTokenExpiration>1900000000</AccessTokenExpiration>", 2_000_000_000_000)).toBe(0);
  });
  it("says nothing when the field is missing or unreadable", () => {
    expect(tokenLifetimeFrom("<Account><AccessToken>t</AccessToken></Account>")).toBeNull();
    expect(tokenLifetimeFrom("<AccessTokenExpiration>0</AccessTokenExpiration>")).toBeNull();
    expect(tokenLifetimeFrom("<AccessTokenExpiration>soon</AccessTokenExpiration>")).toBeNull();
  });
});

describe("logins per account", () => {
  it("counts an account's logins within a window, forgetting what is older than an hour", async () => {
    const { noteAccountLogin, accountLoginsWithin, resetAccountLogins } = await import("../tokenCache");
    resetAccountLogins();
    const now = 10_000_000;
    noteAccountLogin("a", now - 3_700_000);
    noteAccountLogin("a", now - 1_000_000);
    noteAccountLogin("a", now - 10_000);
    noteAccountLogin("b", now);
    expect(accountLoginsWithin("a", 30 * 60_000, now)).toBe(2);
    expect(accountLoginsWithin("a", 60_000, now)).toBe(1);
    expect(accountLoginsWithin("b", 60_000, now)).toBe(1);
    expect(accountLoginsWithin("c", 60_000, now)).toBe(0);
    resetAccountLogins();
  });
});
