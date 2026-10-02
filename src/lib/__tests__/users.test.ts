// Player accounts and linked characters against an in-memory database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { ignsOf, linkIgn, unlinkIgn, userForIgn } from "../users";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => db.close());

describe("users and linked IGNs", () => {
  it("creates a user on first sight of a name and keeps the casing current", () => {
    const a = userForIgn(db, "Comrade", "comrade");
    expect(userForIgn(db, "COMRADE", "comrade")).toBe(a);
    expect(ignsOf(db, a)).toEqual([{ ign: "COMRADE", ignLower: "comrade", linkedAt: expect.any(Number) }]);
    expect(userForIgn(db, "Other", "other")).not.toBe(a);
  });
  it("links a fresh name, and absorbs a name whose own account is empty", () => {
    const a = userForIgn(db, "Main", "main");
    expect(linkIgn(db, a, "Alt", "alt")).toEqual({ ok: true, absorbed: false });
    const stray = userForIgn(db, "Stray", "stray");
    expect(linkIgn(db, a, "Stray", "stray")).toEqual({ ok: true, absorbed: true });
    expect(ignsOf(db, a).map((i) => i.ign)).toEqual(["Main", "Alt", "Stray"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(stray)).toEqual({ n: 0 });
    // Linking a name already on the account is a no-op.
    expect(linkIgn(db, a, "Alt", "alt")).toEqual({ ok: true, absorbed: false });
  });
  it("refuses to take a name off an account with other names", () => {
    const a = userForIgn(db, "Main", "main");
    const twoNames = userForIgn(db, "Twin", "twin");
    linkIgn(db, twoNames, "Twinb", "twinb");
    const r = linkIgn(db, a, "Twin", "twin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(ignsOf(db, a).map((i) => i.ign)).toEqual(["Main"]);
  });
  it("unlinks any name but the last", () => {
    const a = userForIgn(db, "Main", "main");
    linkIgn(db, a, "Alt", "alt");
    const r = unlinkIgn(db, a, "main");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remaining.map((i) => i.ign)).toEqual(["Alt"]);
    expect(unlinkIgn(db, a, "alt")).toMatchObject({ ok: false, status: 409 });
    expect(unlinkIgn(db, a, "nobody")).toMatchObject({ ok: false, status: 404 });
    // The unlinked name is free again and gets a fresh account on next login.
    expect(userForIgn(db, "Main", "main")).not.toBe(a);
  });
});
