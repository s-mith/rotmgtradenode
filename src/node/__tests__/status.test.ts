// The status card's words, from each source: setup, a Realm update, Realm's
// slow-down, upkeep, accounts, proxies, rotmg trade, the site.
import { describe, expect, it } from "vitest";
import { buildStatus, plainLoginProblem, type StatusFacts } from "../status";
import type { SetupView } from "../setup";
import { MAX_NODE_BOTS } from "../../shared/hubWire";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
function setup(o: { complete?: boolean; mode?: "proxies" | "own" | "none" } = {}): SetupView {
  const mode = o.mode ?? "proxies";
  return {
    ok: true, complete: o.complete ?? true,
    steps: {
      accounts: { done: true, count: 2, ready: 2 },
      connection: { done: mode !== "none", mode, proxies: mode === "proxies" ? 3 : 0, working: null },
      hub: { done: true, linked: false, skipped: true },
      test: { done: false, last: null },
    },
  };
}
function facts(o: { [K in keyof StatusFacts]?: Partial<StatusFacts[K]> } = {}): StatusFacts {
  return {
    now: NOW,
    setup: (o.setup as SetupView) ?? setup(),
    gate: { holdReason: null, ratePausedMs: 0, ...o.gate },
    tradeHold: { active: false, reason: null, ...o.tradeHold },
    proxies: { listed: 3, enabled: 3, failing: 0, banned: 0, checked: 0, working: 0, ...o.proxies },
    accounts: { total: 2, ready: 2, inGame: 0, busy: 0, suspended: [], problems: [], ...o.accounts },
    hub: { linked: false, outdated: false, lastError: null, lastHeartbeatAt: null, ...o.hub },
    ...(o.site ? { site: { communismError: null, frozen: false, ...o.site } } : {}),
  };
}
const ids = (s: ReturnType<typeof buildStatus>) => s.problems.map((p) => p.id);
const JARGON = /proxy pool|canary|tracker|pyrelay|holdReason|ECONN|FAILURE|errorId|exit IP/i;

describe("buildStatus", () => {
  it("is ready when set up, idle and fine", () => {
    const s = buildStatus(facts());
    expect(s).toMatchObject({ ok: true, state: "ready", headline: "Ready", problems: [] });
    expect(s.sub).toMatch(/2 accounts ready/);
  });

  it("says how many bots are in the game, and the trades going on", () => {
    expect(buildStatus(facts({ accounts: { inGame: 1 } }))).toMatchObject({ state: "running", headline: "Running: 1 bot in the game" });
    expect(buildStatus(facts({ accounts: { inGame: 3, busy: 2 } }))).toMatchObject({ state: "running", headline: "Running: 3 bots in the game", sub: "2 trades going on now." });
  });

  it("asks to finish the setup first, whatever else is wrong", () => {
    const s = buildStatus(facts({ setup: setup({ complete: false }), gate: { holdReason: "Realm build 7.0.0.9.0 is new to this node" } }));
    expect(s).toMatchObject({ state: "needs-setup", headline: "Finish setting up" });
    expect(s.problems[0]).toMatchObject({ id: "setup", fix: { kind: "link", href: "/setup" } });
    expect(buildStatus(facts({ accounts: { total: 0, ready: 0 } })).problems[0]).toMatchObject({ id: "setup-accounts", fix: { kind: "tab", tab: "accounts" } });
    expect(buildStatus(facts({ setup: setup({ mode: "none" }), proxies: { listed: 0, enabled: 0 } })).problems[0]).toMatchObject({ id: "setup-connection", fix: { kind: "tab", tab: "proxies" } });
  });

  it("explains a pause for a Realm update and offers to check again", () => {
    const held = facts({ gate: { holdReason: "Realm build 7.0.0.9.0 is new to this node; waiting for a rotmgtradenode update, or run a canary login from the console" } });
    let s = buildStatus(held);
    expect(s).toMatchObject({ state: "paused", headline: "Paused: Realm updated the game" });
    expect(s.sub).toMatch(/confirms this node works with the new version.*Check again/);
    expect(s.problems[0]).toMatchObject({ id: "paused", fix: { label: "Check again", kind: "post", path: "/api/dev/node", body: { action: "check-build" } } });
    s = buildStatus({ ...held, hub: { ...held.hub, linked: true } });
    expect(s.sub).toMatch(/usually within an hour/);
    s = buildStatus(facts({ gate: { holdReason: "Realm build 7.0.0.2.0 was refused by the server as outdated; waiting for the version feed to name the new build" } }));
    expect(s).toMatchObject({ state: "paused", headline: "Paused: Realm updated the game" });
    expect(s.sub).toMatch(/fetching the new version number/);
    expect(`${s.headline} ${s.sub}`).not.toMatch(JARGON);
  });

  it("says when Realm asked the node to slow down, and until when", () => {
    const s = buildStatus(facts({ gate: { ratePausedMs: 5 * 60_000 } }));
    expect(s).toMatchObject({ state: "paused", headline: "Paused: Realm asked us to slow down" });
    expect(s.sub).toMatch(/Logins start again at \d{1,2}[:.]\d{2}/);
  });

  it("says when trades wait for upkeep", () => {
    expect(buildStatus(facts({ tradeHold: { active: true, reason: "ban sweep" } }))).toMatchObject({ state: "paused", headline: "Paused for upkeep", sub: expect.stringMatching(/ban sweep/) });
  });

  it("names each account that needs the owner, errors first", () => {
    const s = buildStatus(facts({
      accounts: {
        total: 4, ready: 2, suspended: ["Banned"],
        problems: [
          { alias: "Slow", ign: "", kind: "attempt-limit", message: "Realm's login attempt limit", at: NOW },
          { alias: "Typo", ign: "TypoIgn", kind: "bad-credentials", message: "", at: NOW },
          { alias: "Elsewhere", ign: "", kind: "account-in-use", message: "account in use elsewhere (60s)", at: NOW },
          { alias: "Net", ign: "", kind: "network", message: "network error via 1.2.3.4: socket closed", at: NOW },
          { alias: "Home", ign: "", kind: "network", message: "network error via direct: getaddrinfo ENOTFOUND", at: NOW },
          { alias: "Odd", ign: "", kind: "unknown", message: "Realm answered: <Error>Something <b>odd</b></Error>", at: NOW },
        ],
      },
    }));
    expect(s.state).toBe("problem");
    expect(s.problems.filter((p) => p.severity === "error").map((p) => p.id)).toEqual(["suspended:Banned", "login:Typo"]);
    expect(ids(s).slice(0, 2)).toEqual(["suspended:Banned", "login:Typo"]);
    const byId = Object.fromEntries(s.problems.map((p) => [p.id, p]));
    expect(byId["login:Typo"]).toMatchObject({ text: expect.stringMatching(/^TypoIgn: Realm says the email or password is wrong/), fix: { label: "Fix it", kind: "tab", tab: "accounts" } });
    expect(byId["login:Net"]).toMatchObject({ text: expect.stringMatching(/through the proxy/), fix: { tab: "proxies" } });
    expect(byId["login:Home"].text).toMatch(/Couldn't reach Realm/);
    expect(byId["login:Home"].fix).toBeUndefined();
    expect(byId["login:Odd"].text).toMatch(/Realm turned the last login away \(“Something odd”\)/);
    for (const p of s.problems) expect(p.text).not.toMatch(JARGON);
  });

  it("has a word for no account able to log in", () => {
    expect(buildStatus(facts({ accounts: { total: 1, ready: 0, suspended: ["Only"] } }))).toMatchObject({ state: "problem", headline: "No account can log in" });
  });

  it("keeps running with a warning when bots are in the game", () => {
    const s = buildStatus(facts({ accounts: { inGame: 1, total: 3, ready: 2, suspended: ["Banned"] } }));
    expect(s.state).toBe("running");
    expect(ids(s)).toEqual(["suspended:Banned"]);
  });

  it("speaks about proxies that are off, dead, failing or blocked", () => {
    expect(ids(buildStatus(facts({ proxies: { enabled: 0 } })))).toEqual(["proxies-off"]);
    expect(buildStatus(facts({ proxies: { checked: 3, working: 0 } }))).toMatchObject({ state: "problem", problems: [{ id: "proxies-dead", severity: "error" }] });
    expect(ids(buildStatus(facts({ proxies: { checked: 2, working: 0 } })))).toEqual([]);
    expect(buildStatus(facts({ proxies: { failing: 2 } })).problems[0].text).toBe("2 of your 3 proxies keep failing. Test them and replace the bad ones.");
    expect(buildStatus(facts({ proxies: { banned: 1 } })).problems[0].text).toMatch(/^Realm blocked 1 proxy\. The node rests it/);
  });

  it("speaks about rotmg trade: an outdated app, a node it forgot, no answer", () => {
    expect(ids(buildStatus(facts({ hub: { linked: true, outdated: true } })))).toEqual(["hub-outdated"]);
    expect(buildStatus(facts({ hub: { linked: true, lastError: "unknown node" } })).problems[0]).toMatchObject({ id: "hub-unlinked", fix: { tab: "node" } });
    expect(buildStatus(facts({ hub: { linked: true, lastError: "hub unreachable: fetch failed", lastHeartbeatAt: NOW - 10 * 60_000 } })).problems[0]).toMatchObject({ id: "hub-unreachable", fix: { kind: "post", body: { action: "hub-heartbeat" } } });
    // A blip right after a good heartbeat is not worth a word.
    expect(ids(buildStatus(facts({ hub: { linked: true, lastError: "hub returned 502", lastHeartbeatAt: NOW - 60_000 } })))).toEqual([]);
    // Not linked: nothing about the hub.
    expect(ids(buildStatus(facts({ hub: { linked: false, lastError: "unknown node" } })))).toEqual([]);
  });

  it("adds the site's facts and too many accounts", () => {
    const s = buildStatus(facts({ site: { frozen: true, communismError: "no room left" }, accounts: { total: MAX_NODE_BOTS + 2, ready: MAX_NODE_BOTS + 2 } }));
    expect(ids(s)).toEqual(["too-many-accounts", "hub-frozen", "communism"]);
    expect(s.problems[0].text).toMatch(new RegExp(`Remove 2\\.$`));
  });
});

describe("plainLoginProblem", () => {
  it("never repeats Realm's raw text beyond a short quote", () => {
    expect(plainLoginProblem("unknown", `Realm answered: ${"x".repeat(500)}`).length).toBeLessThan(200);
    expect(plainLoginProblem("unknown", "")).toBe("The last login didn't work. The node tries again later.");
  });
});
