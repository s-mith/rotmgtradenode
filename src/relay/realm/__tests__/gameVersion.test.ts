import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GAME_VERSION_URL, GameVersion, parseBuildInfo } from "../gameVersion";

const FEED = "Last Updated: 2026-09-01T11:16:27.529Z\nVersion: f396e0924c0abce75e2022a57de0a8b9\nGame Version: 7.0.0.0.0\nFile Size: 17487788 bytes\n";

function feed(body: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, { status, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
}

describe("parseBuildInfo", () => {
  it("reads the metadata feed", () => {
    expect(parseBuildInfo(FEED)).toEqual({ gameVersion: "7.0.0.0.0", metadataVersion: "f396e0924c0abce75e2022a57de0a8b9", updatedAt: "2026-09-01T11:16:27.529Z" });
  });
  it("tolerates CRLF, spacing and case", () => {
    expect(parseBuildInfo("game version :  7.1.2.0.0 \r\nVersion:abc\r\n")?.gameVersion).toBe("7.1.2.0.0");
  });
  it("rejects feeds without a build-shaped Game Version", () => {
    expect(parseBuildInfo("")).toBeNull();
    expect(parseBuildInfo("<html>maintenance</html>")).toBeNull();
    expect(parseBuildInfo("Game Version: unknown\n")).toBeNull();
    expect(parseBuildInfo("Version: f396e0924c0abce75e2022a57de0a8b9\n")).toBeNull();
  });
});

describe("GameVersion", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gv-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("serves the seed until the feed answers, then follows it", async () => {
    const gv = new GameVersion({ seed: "7.0.0.0.0", url: "https://feed/x", fetchImpl: feed(FEED.replace("7.0.0.0.0", "7.1.0.0.0")), log: () => {} });
    const seen: string[] = [];
    gv.onChange((v, prev) => seen.push(`${prev}>${v}`));
    expect(gv.current).toBe("7.0.0.0.0");
    expect(await gv.refresh()).toBe(true);
    expect(gv.current).toBe("7.1.0.0.0");
    expect(seen).toEqual(["7.0.0.0.0>7.1.0.0.0"]);
    expect(await gv.refresh()).toBe(false);
    expect(seen).toHaveLength(1);
    expect(gv.lastInfo?.metadataVersion).toBe("f396e0924c0abce75e2022a57de0a8b9");
  });

  it("keeps the last build when the feed is down or garbled", async () => {
    const log: string[] = [];
    for (const impl of [feed("", 503), feed("<html>nope</html>"), vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch]) {
      const gv = new GameVersion({ seed: "7.0.0.0.0", url: "https://feed/x", fetchImpl: impl, log: (l) => log.push(l) });
      expect(await gv.refresh()).toBe(false);
      expect(gv.current).toBe("7.0.0.0.0");
      expect(gv.lastError).toBeTruthy();
    }
    expect(log).toHaveLength(3);
  });

  it("writes the cache file so a restart with the feed down has the new build", async () => {
    const dir = tmp();
    const cacheFile = path.join(dir, "nested", "gameVersion.txt");
    const gv = new GameVersion({ seed: "7.0.0.0.0", url: "https://feed/x", cacheFile, fetchImpl: feed(FEED.replace("7.0.0.0.0", "7.2.0.0.0")), log: () => {} });
    await gv.refresh();
    expect(fs.readFileSync(cacheFile, "utf8").trim()).toBe("7.2.0.0.0");
  });

  it("shares one in-flight request", async () => {
    const impl = feed(FEED);
    const gv = new GameVersion({ seed: "6.0.0.0.0", url: "https://feed/x", fetchImpl: impl, log: () => {} });
    const [a, b] = await Promise.all([gv.refresh(), gv.refresh()]);
    expect([a, b]).toEqual([true, true]);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("is inert without a url", async () => {
    const gv = new GameVersion({ seed: "7.0.0.0.0", url: null, log: () => {} });
    expect(gv.polling).toBe(false);
    expect(await gv.refresh()).toBe(false);
    gv.start();
    gv.stop();
  });

  describe("fromEnv", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of ["GAME_VERSION", "GAME_VERSION_URL", "GAME_VERSION_POLL_S"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("defaults to the public feed and the compiled-in build", () => {
      delete process.env.GAME_VERSION;
      delete process.env.GAME_VERSION_URL;
      const gv = GameVersion.fromEnv(tmp(), () => {});
      expect(gv.current).toBe("7.0.0.0.0");
      expect(gv.polling).toBe(true);
      expect(gv["url"]).toBe(DEFAULT_GAME_VERSION_URL);
    });

    it("seeds from GAME_VERSION, else the data dir cache", () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, "gameVersion.txt"), "7.3.0.0.0\n");
      delete process.env.GAME_VERSION;
      expect(GameVersion.fromEnv(dir, () => {}).current).toBe("7.3.0.0.0");
      process.env.GAME_VERSION = "7.4.0.0.0";
      expect(GameVersion.fromEnv(dir, () => {}).current).toBe("7.4.0.0.0");
    });

    it("GAME_VERSION_URL=off pins the seed", () => {
      process.env.GAME_VERSION = "7.0.0.0.0";
      process.env.GAME_VERSION_URL = "off";
      expect(GameVersion.fromEnv(tmp(), () => {}).polling).toBe(false);
    });
  });
});
