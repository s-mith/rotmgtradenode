// Deposit room under advanced management (docs/relay/ADVANCED.md): the fleet's
// own figure for how big a deposit each side takes now, communism's included,
// and what the form is told about deposits that continue on the next bot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { PyrelayPool } from "../devauth";

let db: Database.Database;
let poolNow: PyrelayPool;

vi.mock("../db", async (orig) => ({ ...(await orig<typeof import("../db")>()), getDb: () => db }));
vi.mock("../devauth", async (orig) => ({
  ...(await orig<typeof import("../devauth")>()),
  pyrelay: { pool: async () => ({ ok: true as const, status: 200, data: poolNow }) },
}));

const { openDatabase } = await import("../db");
const { createDepositRequest } = await import("../depositRequest");
const { registerAdvancedSettings } = await import("../advanced");
const { DEFAULT_ADVANCED } = await import("../../node/settings");
const q = await import("../queue");
const { GET } = await import("../../server/api/capacity/route");

const advanced = (o: { pool?: boolean; communism?: boolean }) => registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, pool: !!o.pool, communism: !!o.communism }));
const deposit = (o: { slots: number; communism?: boolean; ign?: string }) =>
  createDepositRequest(db, { ign: o.ign ?? "Comrade", ignLower: (o.ign ?? "Comrade").toLowerCase(), server: "USEast", slots: o.slots, seasonal: 1, communism: o.communism });

beforeEach(() => {
  db = openDatabase(":memory:");
  // Three communism accounts holding 2 each (6 free apiece), two pool bots holding 4 each.
  poolNow = {
    ok: true,
    bots: { c1: { patk: 2 }, c2: { patk: 2 }, c3: { patk: 2 }, p1: { pdef: 4 }, p2: { pdef: 4 } },
    capacities: { c1: 8, c2: 8, c3: 8, p1: 8, p2: 8 },
    instances: {},
    botMeta: {
      c1: { ign: "C1", server: "", online: false, seasonal: true, communism: true },
      c2: { ign: "C2", server: "", online: false, seasonal: true, communism: true },
      c3: { ign: "C3", server: "", online: false, seasonal: true, communism: true },
      p1: { ign: "P1", server: "", online: false, seasonal: true },
      p2: { ign: "P2", server: "", online: false, seasonal: true },
    },
    room: { seasonal: { largestFree: 4, canMake: false }, nonseasonal: { largestFree: 0, canMake: false } },
  };
});
afterEach(() => {
  registerAdvancedSettings(null);
  db.close();
});

describe("deposit room", () => {
  it("communism takes the fleet's figure for the side when it reports one, else the most one account has free", async () => {
    expect(await deposit({ slots: 12, communism: true })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/most one trade can take is 6/) });
    advanced({ communism: true });
    poolNow.room!.communism = { seasonal: { largestFree: 12 }, nonseasonal: { largestFree: 0 } };
    expect(await deposit({ slots: 12, communism: true })).toMatchObject({ ok: true });
  });

  it("says how much the side takes, not one bot, when deposits continue on the next empty bot", async () => {
    expect(await deposit({ slots: 6 })).toMatchObject({ ok: false, error: expect.stringMatching(/No bot has 6 free slots right now; the most one trade can take is 4/) });
    advanced({ pool: true });
    expect(await deposit({ slots: 6 })).toMatchObject({ ok: false, error: "This pool can take 4 items right now, not 6. Bring fewer, or try again later." });
    poolNow.room!.seasonal.largestFree = 6;
    expect(await deposit({ slots: 6 })).toMatchObject({ ok: true });
  });

  it("tells the fleet a deposit is waiting", async () => {
    let heard = 0;
    const off = q.onPendingChange(() => heard++);
    await deposit({ slots: 4 });
    expect(heard).toBe(1);
    await deposit({ slots: 4 });
    // The second is refused (one deposit per IGN at a time): nothing new to claim.
    expect(heard).toBe(1);
    off();
  });

  it("the capacity report says whether deposits continue, per pool kind", async () => {
    const read = async () => (await GET(new Request("http://site.local/api/capacity?pool=seasonal"))).json();
    expect(await read()).toMatchObject({ continues: false, communismContinues: false, largestFree: 4 });
    advanced({ pool: true });
    expect(await read()).toMatchObject({ continues: true, communismContinues: false });
    advanced({ communism: true });
    expect(await read()).toMatchObject({ continues: false, communismContinues: true });
  });
});
