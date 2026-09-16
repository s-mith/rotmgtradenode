# Realm hunts — a bot that holds the party and counts who follows it in

Realm hunting is killing a realm's minions until they drop the portal of a
dungeon you want, then getting everyone in. This feature puts a fleet bot
behind the hunting party: it opens the party, and every time a hunter who
has found and entered the dungeon says "j", the bot teleports to them
through the party, counts who follows, and reports it. The hunters do the
hunting; the bot only maintains the party and keeps the count honest.

Lives beside the dungeon raids (docs/RAIDS.md): same Raids bookmark, second
sub-tab **Realmhunting** (`src/components/Realmhunting.tsx`), same fleet
plumbing (`src/relay/fleet/realmHunt.ts` next to `raidWatch.ts`), same
hook pattern (`src/lib/realmhunts.ts` ↔ the fleet, in process).

## 1. The flow

0. **Request.** Someone logged in picks a dungeon and a region (US, EU)
   and posts. One open hunt per requester, and **one open hunt per dungeon
   and region** — other dungeons may run in the same region (a second
   requester for the same one is told whose hunt to join; a unique partial
   index, migration 15, makes a race lose too).
1. **A party for it.** The site picks the quietest server in the region
   (the withdraw qualifiers: the operator's per-server switch, then Realm's
   load reading) and orders a hunter. The hunter logs in there, stays in
   the Nexus, asks for its party (PARTYACTION refresh) and, in none, sends
   CREATEPARTY: description `realmhunt <Dungeon> <Region>` (e.g.
   "realmhunt Moonlight Village US"), **max size = the dungeon's player
   limit** (`raidDungeons.ts`), public, activity "realm", serverIndex = the
   server's place in account/servers. The party's id comes back in
   PARTYMEMBERINFO. Join requests are accepted as they come; a public party
   adds members directly (PARTYMEMBERADDED).
2. **Wait for a call.** Party chat arrives as TEXT with recipient
   `*Party*`; the sender's name may carry a name-style tag ("Chambara,fe14"
   — 30 of 129 live lines did), so every name is compared bare
   (`bareName`, the part before the first comma). A call is a line that is `j` or `join`, alone or followed by
   anything ("j lb", "join me"); not "jk", "joined". Every member joining is
   greeted with what to do: hunt any realm, and say j once inside the
   dungeon.
3. **Join and count.** The bot sends PARTYACTION {playerId = the caller's
   party player id, action 7 TeleportTo}. The server answers with a
   RECONNECT into the caller's instance (verified live 2026-09-14: the
   Nexus → an Infernal Abyss); the relay client follows it. From the moment
   the dungeon's MAPINFO arrives the bot counts every player object it sees
   for **30 s** (`JOIN_COUNT_WINDOW_S`), present or gone — how many in all
   and how many of them are party members. It says the count in party chat,
   reports it to the site, and nexuses.
4. **Repeat.** Back in the Nexus it reports "hunting" and waits for the
   next call. **The bot waits 20 minutes for a call** (`CALL_IDLE_MS`);
   every call that lands it in the hunted dungeon (outcome "counted", not
   another dungeon, not a failed teleport) restarts that clock. When it
   runs out the bot says so in party chat, leaves the party, and the hunt
   ends ("idle"). It re-reads its party once a minute (PARTYACTION refresh)
   so the member list and the ids a teleport needs stay current. A hunt
   also ends at a 12-hour ceiling, or when the hunter fails (then it can be
   posted again); a hunt with no bot at all is ended idle by the site's
   sweep 20 minutes after posting. **Nobody closes a hunt by hand** — not
   the requester either; only an operator can, from the dev console
   (`/api/dev/realmhunts`).

Every call is a row on the hunt's card: caller, "N in (M party)", or why
it did not count (the caller is not in the party, the teleport brought no
new map, the map was not the hunt's dungeon — counted anyway and marked —
or the connection dropped).

## 2. Site

**Points** (migration 13, `realmhunt_rewards`; like docs/RAIDS.md §7c): on
a call the bot counted in the hunted dungeon, every party member it saw
there earns 0.1 (`HUNTER_POINTS_ENTERED`) and the caller who found it
earns 0.1 per such member, themself excluded (`FINDER_POINTS_PER_HUNTER`).
Paid only to names with a site account; a call into another dungeon or a
failed teleport pays nothing. The leaderboard adds them with the raid
points; the profile lists them as activity.

- Tables (migration 12): `realmhunts`, `realmhunt_calls`, `realmhunt_events`.
- `GET/POST /api/realmhunts`, `GET /api/realmhunts/:id`; operator: `GET/POST /api/dev/realmhunts` (end, delete) behind the dev console's **Realm hunts** tab (`src/client/pages/dev/settings/RealmhuntsTab.tsx`).
- Live: the `realmhunts` SSE event (liveBus → useLive → the Realmhunting tab).
- Scheduler: `sweepHunts` every raid-sweep interval (timeouts, deletion a
  day after ending).
- Nothing is hidden: the server, the realm and the party name are how a
  hunter finds the bot.

## 3. Fleet

`RealmHuntService` (one hunter per hunt): pick an idle account that holds
nothing and has no backpack (same server preferred; the previous attempt's
account first), hold it, bring it up, the trip above. **A hunter has no
self-preservation by design**: it stands at dungeon entrances and may die.
Then the next bring-up creates a new character (the account keeps its
party), what it saw before dying still counts, and the trip is retried —
up to `MAX_RETRIES` (6) failures in a row, the counter resetting every
time a trip reaches "hunting" again. Past that the hunter reports
`failed`, which ends the hunt on the site. `REALM_HUNTS=1`
attaches the site in `src/server/main.ts`; open hunts are ordered again
after a restart (`reorderOpenHunts`).

The trip's pure parts are tested (`realmHunt.test.ts`): the count, the
party state (member ids for the teleport), the chat filter, the service's
bookkeeping with a stub trip.

## 4. Party packets (build 7.0)

Named in `packetIds.ts` after what they carry (the client swaps the names
of 204 and 207):

| id | dir | name | fields |
| --- | --- | --- | --- |
| 1 | c2s | TELEPORT | objectId i32, playerName str |
| 200 | c2s | CREATEPARTY | description str, minPowerLevel u16, maxPartySize u8, activity u8, maxedStatReq u8, privacy u8, serverIndex u8 |
| 204 | c2s | PARTYACTION | playerId u16, actionId u8 (1 kick, 2 disconnect, 3 promote, 4 refresh, 5 list, 6 leave, 7 teleport to) |
| 207 | s2c | PARTYACTIONRESULT | playerId u16, result u8 (1 failed, 2 kicked, 3 kick not found, 4 promoted, 5 promote not found, 6 left) |
| 208 | s2c | PARTYINVITE | partyId u32, inviterName str |
| 209 | c2s | PARTYINVITERESPONSE | partyId u32, accept u8 |
| 210 | s2c | PARTYMEMBERINFO | partyId u32, unknown u16, maxSize u8, players[] {playerId u16, name str, classId u16, skinId u16}, description str |
| 212 | s2c | PARTYMEMBERADDED | playerId u16, name str, classId u16, skinId u16 |
| 214 | s2c | PARTYLIST | packetNumber u8 (0xff = last page), parties[] {description str, partyId u32, minPowerLevel u16, size u8, maxSize u8, activity u8, privacy u8, minStats u8, serverIndex u8} |
| 215 | c2s / s2c | PARTYJOINREQUEST | partyId u32, state u8 (c2s sends 1; a public party answers with PARTYMEMBERINFO) |
| 217 | s2c / c2s | PARTYJOINREQUESTRESPONSE | name str, classId u16, skinId u16, state u8 (3 accept, 4 decline) |

Inviting is not a packet: the client sends PLAYERTEXT `/pinvite NAME` and
the server answers with a system TEXT. Party chat is PLAYERTEXT `/p …` out,
TEXT with recipient `*Party*` in.

## 5. Verified and not (as of 2026-09-14)

Verified on the wire with a human client through rotmgproxy: the ids
above; PARTYACTION `ffff05` (list), `ffff04` (refresh) and `01f507`
(teleport to member 0x01f5 — answered by a RECONNECT {name "", host, port
2050, gameId 6242, key} into the member's dungeon, then HELLO with that
gameId and the dungeon's MAPINFO); PARTYJOINREQUEST `000021f001` joining a
public party, answered by the full PARTYMEMBERINFO; PARTYMEMBERINFO
`ffffffff…` (11 bytes) when in no party; a full PARTYLIST page byte for
byte (`party.test.ts`); PARTYMEMBERADDED for "Jetson"; CREATEPARTY's sizes;
party chat as `*Party*`.

**Refresh after every connection.** The real client sends PARTYACTION
refresh (`ffff04`) right after every MAPINFO. A hunter that did not was
dropped from its party by the server about 40 s after nexusing back from a
dungeon (prod, 2026-09-14 06:02 UTC: the members got "player 1 left" and a
promotion; the bot's next reading said "no party" and its CREATEPARTY went
unanswered). The bot now refreshes on every arrival in a world — after the client's
~1.5 s delay: asked at once, the server answered "no party" for a bot it
still had (prod 06:13 UTC: "1 in (0 from the party)", then a needless
re-create) — believes "no party" only once the connection is 10 s old and
a second answer agrees, counts a call against the members known before
the teleport, and treats an unanswered CREATEPARTY as "probably already in
one" before giving up. Every party info packet it gets is logged.

Not yet verified — the first live hunt is what checks them:

1. **serverIndex** — assumed to be the server's index in account/servers.
   Check: create a party on a known server through the proxy (hex is on)
   and compare the byte.
2. **PARTYACTIONRESULT field order** (playerId then result, per the
   protocol dump's order; the client struct has them the other way).
3. **PARTYJOINREQUESTRESPONSE** as the leader's accept; a public party
   seems not to need one (the join above was immediate).
4. **Leaving the party** with playerId 0xffff (the list request's id).
5. Whether the party survives the bot's nexus (PARTYMEMBERINFO on load
   says; the bot asks with a refresh and re-creates when none).
6. The count: the bot lands where the caller stands; players who arrive and
   leave view within the window are still counted (kept as gone). Players
   who never come within view (~15 tiles in a dungeon) are not.
