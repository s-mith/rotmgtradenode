// What counts as spoken for: open per-instance withdraws, offers this node
// has on the hub, hand-overs on their way. The withdraw route, the storage
// tuck, the fetch's banking and consolidation all read this one set.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { GIVE_UNQUEUED_MS, reservedByRequests, reservedInstanceIds } from "../reservations";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => db.close());

const withdraw = (ids: string[], status = "pending") =>
  db.prepare("INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, instance_ids_json, seasonal, created_at, updated_at) VALUES ('P', 'p', 'USEast', '[]', ?, ?, 1, 1, 1)").run(status, JSON.stringify(ids));

describe("reservedInstanceIds", () => {
  it("names open picks only, when the coordinators' tables do not exist yet", () => {
    withdraw(["a", "b"]);
    withdraw(["c"], "fulfilled");
    expect([...reservedInstanceIds(db)].sort()).toEqual(["a", "b"]);
  });

  it("adds the items behind open or accepted offers and hand-overs still under way", () => {
    db.exec(`
      CREATE TABLE swap_offers (offer_id INTEGER PRIMARY KEY, side TEXT NOT NULL, bot_guid TEXT NOT NULL, refs_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE swap_rendezvous (rendezvous_id INTEGER PRIMARY KEY, offer_id INTEGER, request_id INTEGER, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE communism_meetings (rendezvous_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, node_id TEXT NOT NULL, item_ids_json TEXT NOT NULL, instance_ids_json TEXT NOT NULL, bot_guid TEXT NOT NULL, server TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    withdraw(["a"]);
    const offer = db.prepare("INSERT INTO swap_offers (offer_id, side, bot_guid, refs_json, status, created_at, updated_at) VALUES (?, 'poster', 'bot', ?, ?, 1, 1)");
    offer.run(1, JSON.stringify({ r1: "o1", r2: "o2" }), "open");
    offer.run(2, JSON.stringify({ r1: "o3" }), "accepted");
    offer.run(3, JSON.stringify({ r1: "o4" }), "cancelled");
    offer.run(4, JSON.stringify({ r1: "o5" }), "done");
    const meeting = db.prepare("INSERT INTO communism_meetings (rendezvous_id, kind, node_id, item_ids_json, instance_ids_json, bot_guid, server, created_at) VALUES (?, ?, 'n', '[]', ?, 'bot', 'USEast', ?)");
    meeting.run(10, "give", JSON.stringify(["g1"]), Date.now());
    meeting.run(11, "give", JSON.stringify(["g2"]), 1);
    meeting.run(12, "take", JSON.stringify([]), 1);
    // Queued long ago and still meeting: held. Never queued and older than GIVE_UNQUEUED_MS: let go.
    meeting.run(13, "give", JSON.stringify(["g3"]), 1);
    meeting.run(14, "give", JSON.stringify(["g4"]), Date.now() - GIVE_UNQUEUED_MS - 1000);
    db.prepare("INSERT INTO swap_rendezvous (rendezvous_id, offer_id, request_id, state, created_at, updated_at) VALUES (11, NULL, 5, 'done', 1, 1), (13, NULL, 6, 'meet', 1, 1)").run();
    expect([...reservedInstanceIds(db)].sort()).toEqual(["a", "g1", "g3", "o1", "o2", "o3"]);
    // The narrower view a meeting about to be queued checks against: open requests alone.
    expect([...reservedByRequests(db)]).toEqual(["a"]);
  });
});
