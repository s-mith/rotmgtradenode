# Raids — from posting a key to the end of the run, end to end

This is the whole process a raid goes through on the site, in the game, and
in the fleet: what the leader and the raiders do, what the site does at each
stage, and what the watcher bot does to prove the pop. It is the plan the
rest of the raids work follows.

Status (2026-09-13, third pass): everything below is implemented on the
`raids` branch — the five stages with the fixed two-minute AFK check and
two-minute pop window (§3), the watcher service in the fleet
(`src/relay/fleet/raidWatch.ts`, §5), the site's side of it (`lib/raids.ts`:
orders through the hook, verdicts from the reports, migration 8's pop
attempts and audit, migration 9's leader range, migration 10's strikes),
the next-key flow (§4.5), the leader-honesty rules (§7b), the card, profile
history and dev tab (§7). Watchers are off until `RAID_WATCHERS=1` is set
with the embedded fleet; until then every raid runs unverified. The watcher
has been run locally against real raids on USSouth3 (eight raids over the
day: confirmed pops of Woodland Labyrinth and Ice Citadel, a stranger's pop
recorded as `other`, one verified no-pop, modifiers filled in a tick late);
the answers are in §10. The first runs on prod, with the dev tab open, are
the rollout's next step (§9). The ★ marks are kept as a record of what was
new against the first cut.

Timers as built: AFK check 120 s (fixed), pop window 120 s, one extension of
120 s, watcher kept 60 s past the window to see the portal close, an early
watcher call during headcount held for 10 min at most.

---

## 1. Goal and principles

**Goal.** A raid finder whose word can be trusted: when the site says a raid
was popped, a bot of ours stood in the announced bazaar and saw the portal
open, saw who opened it, and saw who was there. Leaders who announce and
don't pop are recorded as such; raiders who show up are recorded as present.

**Principles.**

- **Secrets in stages, like the Discord bots.** The region is public; the
  server and bazaar go to a raider when they join the AFK check; the party
  name goes out once the AFK check is complete. The stripping is done by the
  server per viewer (lib/raids.ts `raidView`), never by the browser.
- **The bot observes, it never takes part.** It stands in the bazaar, reads
  the wire, and reports. It never enters the dungeon, never pops, never
  trades while on the job. Bazaars are safe zones; nothing there can kill it.
- **The site works without the bot.** No free exit, a login queue, a fleet
  restart: the raid still runs, marked *unverified* rather than failed.
- **One watcher per (server, bazaar side), shared.** Several raids popping
  in the same bazaar are watched by one bot.
- **Everything the wire says about a pop is kept.** Opener account, dungeon
  modifiers, timestamp, the roster at that moment — on the raid record, for
  the finder, the leader's history and the operator.

## 2. The cast, and what each one knows

| who | knows | proves it by |
| --- | --- | --- |
| **Leader** | which key they hold, which server they will pop on, which bazaar, their party name | logged in on the site with the IGN they play (the in-game /tell login) |
| **Raider** | what the site shows them for their stage | same login; their site IGN is their in-game name |
| **Site** (rotmgcommunism) | every raid, who joined when, what the watcher reported | the database; live events to browsers |
| **Watcher** (a fleet bot) | what its own game connection streams: every player object in the bazaar (NAME, ACCOUNTID, guild, stars, level, position), every portal object (type, OWNERACCOUNTID, MODIFIERS, OPENEDATTIMESTAMP, NAME) | it is in the world, on the wire |
| **Realm** | everything | — |

Because a site login proves the IGN, the watcher's roster (names) matches
site accounts (IGNs) by name, case-insensitively. The opener comes over the
wire as an account id on the portal; the roster turns that into a name
(every player object carries its ACCOUNTID and NAME), and that name is
compared with the raid's leader.

## 3. The stages

★ marks the one new stage. Timers are the defaults; every one is a constant
in lib/raids.ts.

| stage | who moves it | raiders see | party | watcher | leaves it by |
| --- | --- | --- | --- | --- | --- |
| **Headcount** | leader posts | region, description, raider list; *Join* counts them in | hidden | none (leader may call one early) | leader starts the AFK check; 30 min idle → ended (timeout) |
| **AFK check** (2 min, fixed) | leader | joined raiders: server + bazaar; *Join* now reveals them at once | hidden | dispatched: logs in, enters the bazaar, reports the roster | the timer runs out, or the leader closes it early → **Pop** |
| ★ **Pop** (window: 2 min, one extension of 2 min) | automatic at AFK end; again from Running when the leader presses *Next pop* with keys left | "be in the bazaar"; party name; the leader's pop prompt; who is seen present | revealed | in place, armed for this raid's portal type; reports the pop | pop confirmed → **Running**; window over with a watcher in place and no pop → **Ended (no pop)**; window over with no watcher → **Running (unverified)** |
| **Running** | the pop, or the window | "popped ✓ by Leader, N entered" or "unverified"; latecomers see it is in progress | revealed | watches the portal close, counts who went in, then leaves | leader ends it; 90 min idle → ended (timeout) |
| **Ended** | leader, timeout, operator | the verdict; listed for an hour | revealed to those who were in it | released | deleted after a day (the record of it stays in raid_events / the leader's history) |

Why a Pop stage: raiders need one clear moment that means "the AFK check is
over, be at the bazaar now, the portal is about to open", and the leader
needs one clear prompt to pop *after* the watcher is in place. "Running"
then means what it says: the dungeon is under way.

## 4. Step by step

```mermaid
sequenceDiagram
  participant L as Leader (game + site)
  participant R as Raiders (game + site)
  participant S as Site
  participant F as Watcher bot
  participant G as Realm
  L->>S: post raid (dungeon, server, bazaar side, party, keys, description)
  S-->>R: card with region only (live event)
  R->>S: join (headcount)
  L->>S: start AFK check (2 min)
  S->>F: watch(server, side, raid id, dungeon portal type, until AFK end + 2 min + grace)
  S-->>R: server + bazaar to joined raiders; notification
  F->>G: log in on the server (Nexus)
  F->>G: walk to the side's Cloth Bazaar Portal, USEPORTAL, follow RECONNECT
  F-->>S: in bazaar; roster (names, account ids)
  S-->>L: watcher in place; raiders present 9/12
  R->>G: walk into the bazaar
  Note over S: AFK check ends → Pop stage; party name revealed
  S-->>L: "pop now"
  L->>G: use the key in the bazaar
  G-->>F: UPDATE: new portal (type, OWNERACCOUNTID, MODIFIERS, ...)
  F-->>S: pop seen (opener, modifiers, roster, who stood beside it)
  S-->>R: "popped ✓ by Leader — enter now" (live event + notification)
  R->>G: enter the portal
  G-->>F: players drop from view; the portal closes
  F-->>S: portal closed; N entered
  F->>G: ESCAPE to the Nexus, disconnect
  L->>S: end run (or the 90 min timeout)
  S-->>R: ended; verdict on the leader's history
```

### 4.1 Before anything: the leader's part in game

The leader has the key on the character they are playing, is on the server
they will announce, and knows which bazaar they will pop in. Nothing on the
site checks any of that in advance — the pop is the check.

### 4.2 Posting (Headcount)

*Leader:* picks the key (any standard key), server, pop location (left or
right bazaar), party name (optional), number of keys, description. Posts.

*Site:* validates (lib/raids.ts `createRaid`): known dungeon, known server,
one of the two bazaars, party name up to 24 plain characters, description up
to 200, keys 0–20, not blocked, no other open raid led by this account.
Stores the raid at `headcount`, makes the leader its first member, emits a
`raids` live event. Everyone's card shows the region ("US · location
hidden"), the description, the leader and the raider list.

*Raiders:* *Join* on the card. During headcount that only counts them in; it
reveals nothing yet ("the exact server and bazaar come with the AFK check").

*Fleet:* nothing by default. ★ The leader's card offers *Call the watcher
now* for when they are nearly ready on a server with a login queue; it
dispatches the watcher early (§5) and shows its state on the card.

*Timers:* a headcount left alone for 30 minutes is ended as a timeout.

### 4.3 The AFK check

*Leader:* presses *Start AFK check* (a fixed two minutes) and goes to the
bazaar in game.

*Site:* `advanceRaid` → `afk`, `afk_ends_at`; emits. Every joined raider's
view now carries the server and bazaar; anyone who joins during the check
gets them on the spot (`locationRevealed`). Raiders who opted into browser
notifications get "AFK check is open. Popping at the Left bazaar on
USSouth3." even in a background tab. ★ The site hands the fleet a watch
order: `{ raidId, server, side, portalType, leaderIgn, until: afk_ends_at +
POP_WINDOW }` (§5.1).

*Watcher:* wakes, enters the bazaar, starts reporting (§5.2). ★ The card
shows its state to everyone: "watcher: logging in on USSouth3" → "queued
(position 41)" → "in the left bazaar ✓". ★ Once inside, it reports the roster
every few seconds; the site matches names against the raid's members and
shows the leader "raiders present in the bazaar: 9 of 12" and each raider
their own tick ("we see you in the bazaar ✓"). This is the AFK check's real
purpose — attendance — done by observation instead of a reaction.

*Raiders:* walk into the announced bazaar in game.

*Timers:* the check ends by itself at `afk_ends_at` (the 5 s sweep), or the
leader closes it early with *Start run now*.

### 4.4 ★ Pop

*Site:* at AFK end, `afk` → `popping`, `pop_window_ends_at = now +
POP_WINDOW (2 min)`, a `raid_pops` row for the attempt; the party name is
revealed to raiders (`partyRevealed`: popping, running, ended). Emits;
notifies raiders "AFK check over — be in the bazaar, party <name>".

*Leader's card:* one of

- "watcher in the left bazaar — **pop now**" (raiders present N/M);
- "watcher still logging in (queued, position 12) — waiting up to 2 min";
- "no watcher (reason) — pop when ready; this raid will be unverified".

*Leader in game:* uses the key at the announced spot.

*Watcher:* has been armed for this raid's dungeon portal type since it
entered (a portal that appeared before the Pop stage counts too — a leader
who pops early is still verified, as long as the watcher was inside to see
it). On the portal object streaming in, it reports (§5.3): portal type and
dungeon, position, OWNERACCOUNTID → the roster name for it, the players
standing on the spot (a key portal spawns at the opener's feet), MODIFIERS,
OPENEDATTIMESTAMP, the full roster, the raid's members among them.

*Site on a pop report:* the portal type must match the raid's dungeon. The
opener is compared with the leader:

- the portal is the raid's dungeon → `pop_verdict = confirmed`, `popping` →
  `running`, `popped_at`, opener, modifiers stored; emit; notify raiders
  "popped ✓ by X — enter now". **Whoever popped it counts**: the raiders are
  there for the dungeon, and the record says who opened it — the server's
  notice names them (§ live findings), else whoever stood on the spot, the
  leader first. A pop by someone other than the leader is shown as "popped ✓
  by X (not the leader)" and logged that way.

*Site at window end without a matching pop:*

- watcher was in place the whole window → `ended`, `pop_verdict = none`,
  `ended_by = no_pop`; raiders are told; it goes on the leader's record.
- watcher never made it (queue, no exit, fleet down) → `running`,
  `pop_verdict = unverified`; the leader may still be honest, we just did not
  see it.

The leader may extend the window once (another 2 minutes); the extension is
shown to raiders.

**More than one key.** After a run, the leader goes back to the bazaar and
presses *Next pop* on the card (Running, keys left): a new pop attempt opens
with its own two-minute window, the watcher is ordered again (or kept, if it
is still there), and the next portal is confirmed the same way. A later
attempt that sees no pop does not end the raid — the first run happened —
it is recorded as `none` on that attempt and the raid stays running. Each
attempt is a `raid_pops` row; the card lists them ("Pop 1 ✓ by Leader, 7
went in · Pop 2 ✓ …").

### 4.5 Running

*Raiders:* enter the portal within its lifetime (a key portal stays for
about 30 s — to be measured) and run the dungeon.

*Watcher:* keeps watching until the portal object is dropped: every raid
member who vanishes from the roster between the pop and the close counts as
*entered* (a heuristic: leaving the bazaar any other way looks the same). It
reports the close with the count, then, when no other raid is subscribed to
this bazaar, presses ESCAPE (Nexus), disconnects, and gives its exit IP back.
The site shows "N raiders entered".

*Site:* the card reads "Running · popped 2 min ago by Leader · 7 entered".
Latecomers who join now see the location and party but the portal is gone;
the card says so.

*Leader:* presses *End run* when the dungeon is done. A run left alone ends
after 90 minutes.

### 4.6 Ended

*Site:* `ended`, `ended_by` (leader, leader_left, timeout, operator,
no_pop). The raid stays listed for an hour with its verdict, then leaves the
list; the row is deleted after a day but ★ `raid_events` keeps the audit
(created, joined, left, afk, watcher states, pop, close, ended), and ★ the
leader's and raiders' histories (raids led / popped / verified rate; raids
joined / present) are computed from it for the profile page and the finder
("Leader · 12 raids, 11 popped").

## 5. The watcher (fleet job) ★

### 5.1 Orders and sharing

The site and the fleet run in one process on prod (`RELAY_EMBEDDED=1`), so
the order is an in-process hook, the way backpack orders already are
(`Dispatcher.setBackpackOrders`): lib/raids.ts calls `raidWatch.order(...)`
on AFK start (or the leader's early call), `raidWatch.release(raidId)` on
ended. For a relay reached over HTTP the same calls go through signed
`/api/bot/raids/*` endpoints like the trade queue does; the first cut only
needs the in-process path.

Watchers are keyed by `(server, side)`. An order for a bazaar that already
has a watcher subscribes the raid to it; the watcher holds until the last
subscribed raid's window has ended. Orders name the raid's portal type
(from the key's `CreatePortal` activate, §6) and the leader's IGN.

### 5.2 One trip

1. **Pick an account.** Offline, not a vault bot, not held, login lockout
   clear; either pool; emptiest first (it will not trade, but an empty bot is
   the cheapest to lose to a kick). An idle online bot already on that server
   is taken instead when there is one.
2. **Hold it.** Added to the dispatcher's holds so the "idle and no work —
   disconnecting" rule and the trade claims leave it alone for the trip.
3. **Wake on the raid's server, Nexus.** Through the normal wake path (exit
   IP claim, stagger, login gate). Report `logging_in`, and `queued (n)` while
   the server's queue holds it (the client sees QUEUEINFORMATION).
4. **Enter the bazaar.** In the Nexus, find the two Cloth Bazaar Portals in
   the object table; the one with the smaller x is the left bazaar (mirror
   flag if the live test says otherwise); walk to it (`GameClient.moveTo`),
   USEPORTAL, follow the RECONNECT. Report `entering`, then `in_bazaar` with
   the world's name.
5. **Watch.** Keep the roster (every player object: name, account id, guild,
   stars, level, position; dropped ones kept as gone) and the portal table.
   Report the roster on change, at most every 3 s. On a dungeon portal
   object appearing, report the pop (§5.3). On its drop, report the close
   with the entered count. **Keep the leader in sight:** a pop only counts if
   the portal streams to the watcher, and it spawns at the popper's feet, so
   the watcher tracks each served raid's leader against its view (25 tiles;
   the line is 20, with 2 tiles of hysteresis). It whispers the leader in game
   (`/tell`) once when it first sees them ("pop within 20 tiles of me"), when
   they stray or vanish ("out of my sight, come within 20 tiles or your pop
   won't count") and when they are back — never two whispers within 8 s —
   and reports each change to the site, which shows it on the leader's card
   and gates the "pop now" prompt on it (`leader_in_range`, migration 9).
6. **Leave.** When no subscribed raid is still in its window: ESCAPE,
   disconnect, release the hold and the exit. Report `done`.

Timeouts: 3 min to get in world (queues), 1 min from Nexus to bazaar; a
kick or disconnect mid-trip retries once if the window still allows, else
reports `failed (reason)`. Every state change goes to the site with a note,
so the card and the dev tab can show it.

### 5.3 The pop report

```
{ raidIds: [..], server, side, portal: { objectId, type, dungeon, pos },
  ownerAccountId, opener: { name, accountId } | null,
  beside: [{ name, accountId, d }], modifiers, openedAt,
  roster: [{ name, accountId }], at }
```

The site resolves the verdict (§4.4). The proxy's `keypop` plugin already
produces exactly this record; the relay port is §6.

### 5.4 Rules

- A watcher never enters a dungeon portal, never uses items, never trades.
- It counts against the online cap and holds an exit IP for the trip (about
  5–8 minutes per raid). With the cap at the proxy count this is small.
- Trade hold (ban sweep) and the login gate's pauses apply: no watcher is
  woken during them; the raid goes unverified.
- One order per raid; one open raid per leader; so a leader cannot spend
  more than one watcher at a time.
- Two raids in the same bazaar with the same dungeon: pops are matched to
  raids by the opener's name against each raid's leader; an unmatched pop is
  recorded against every subscribed raid as `other`.
- A pop seen in the *other* bazaar cannot be seen at all. That is the point:
  the leader pops where they announced. (When capacity is idle, a second
  watcher for the other side is a cheap option later.)

## 6. What the relay client needs (port from rotmgproxy) ★

| piece | proxy (done) | relay |
| --- | --- | --- |
| Portal and key metadata: Class Portal, DungeonName, DungeonPortal, key → portal via `CreatePortal` | `gamedata.ts` | a generated table shipped with the site: `raidDungeons.ts` gains `portalType` per key (script over object.xml), so site and fleet agree on what to look for |
| Player objects with NAME/ACCOUNTID/guild/stars/level, kept when dropped | `players.ts` | extend `client/world.ts` (it tracks objects for walking already) with a roster keyed by object id |
| Dungeon portals appearing/closing with all string and numeric stats | `keypop.ts` | same place; the pop record of §5.3 |
| Bazaar portals by side, entering, following the reconnect | `bazaar.ts`, `walk.ts` | `GameClient.moveTo` + USEPORTAL exist; reconnect following exists for the quest room and vault |
| The trip as a job with states and timeouts | — | `relay/fleet/raidWatch.ts`, like `backpacks.ts`'s trips |

The proxy stays the test bed: every rule above is exercised there with a
human client before the relay version runs on prod.

## 7. Site changes ★

**Migration 8.** `raids`: status gains `popping`; `pop_window_ends_at`,
`pop_verdict` (pending / confirmed / other / none / unverified),
`popped_at`, `pop_opener_ign`, `pop_opener_account`, `pop_modifiers`,
`pop_portal_type`, `watcher_state`, `watcher_note`, `watcher_bot`,
`present_json` (raid members seen in the bazaar, with first-seen times),
`entered_count`, `extended` (0/1). New `raid_events` (raid id, event, actor,
detail JSON, at), append-only, kept past the raid row's deletion.

**lib/raids.ts.** The new stage and its transitions in `advanceRaid` and
`sweepRaids`; `partyRevealed` at popping; `raidView` gains the watcher and
pop fields (public: verdict, opener name, present count, entered count;
member: their own presence; leader: everything); the fleet-facing functions
`watcherUpdate`, `rosterSeen`, `popSeen`, `portalClosed`; `extendPopWindow`;
history queries for profiles.

**API.** `/api/raids` and `/api/raids/:id` carry the new fields; a new
action `extend`; the leader's `call` (early watcher). `/api/profile` gains
raid history. `/api/dev/raids` shows watcher states and events.

**UI.** Card: watcher state line, verdict badge ("popped ✓ by X", "no pop",
"unverified"), present N/M for the leader and "we see you ✓" for a raider,
the Pop stage's prompt and countdown, entered count while running. Creator:
unchanged. Notifications: AFK open, pop stage (party), popped, ended.
Profile: raids led / popped rate / joined / present.

**Dev console.** The Raids tab lists watcher states per raid and the event
log; a "send a watcher to <server> <side> for N minutes" button to exercise
the trip on prod without a raid.

## 7b. Keeping leaders honest ★

The watcher's verdicts feed three rules (all built):

- **The record on the card.** Beside the leader's name: "11/12 popped" (pops
  they made themselves, out of raids led), "no verified pops yet", or "new
  leader"; a red "N strikes" when they have any. Pops someone else made for
  their raid count for the raid but not for the leader's own tally
  (`pop.by_leader` vs `pop.by_other` events). The profile shows the same.
- **Strikes.** A raid that ends because a watcher stood there for the whole
  window and saw no pop, or one the leader cancels (or leaves) after the AFK
  check has sent raiders moving, is a strike. Cancelling during headcount is
  free; "End run" is not a cancel; an operator ending a raid is not one
  either. Strikes decay after 30 days. One active strike is an hour off
  posting, two a day, three a block until an operator clears them in the
  dev console (`raid_strikes`, migration 10; `postingHold`). Linked names
  share the account, so an alt carries the same strikes.
- **The same servers as a withdraw.** A raid can be posted, and its AFK
  check started, only on a server a withdraw may target right now
  (`withdrawBlock`'s two qualifiers): the operator's per-server withdraw
  switch in the dev console, then Realm's own account/servers load reading
  — 75% or 100% full is out, only a server reading 0 is open; a stale
  reading stands down, as it does for trades. The creator uses the withdraw
  picker's list, flag and labels ("busy · 75% full", "disabled"), and drops
  a server that closes under the leader's choice; a server that fills up
  during headcount blocks the AFK check with "cancel (free) and repost".

## 7c. Points ★

Raids pay into the same score the leaderboard ranks by (a point is a claim
on the pool: deposits earn them, withdrawals spend them, an ordinary item is
1). The rules, all in `raidRules.ts`:

- **Only a confirmed pop pays**, and only once the watcher has seen its
  portal close — that is when it knows who went in. Unverified raids, a
  stranger's pop of another dungeon, and a pop whose close was never seen
  pay nothing.
- **No base pay for the pop.** The leader earns **0.1 per raider who went
  in** (`LEADER_POINTS_PER_RAIDER`), uncapped: raid members other than the
  leader who vanished from the bazaar while the portal stood. The leader
  going in themself pays nobody.
- **Each of those raiders earns 0.1** (`RAIDER_POINTS_ENTERED`).

`raid_rewards` (migration 11) holds one row per payee per pop with the
points as paid, so a later rate change never rescores an old raid; the
row outlives the raid. `lib/leaderboard.ts` adds them to the score, the
profile shows them on the calendar, in the activity log ("Led a raid ·
Woodland Labyrinth: 7 raiders went in") and in the raids line, and the
card's pop line reads "7 raiders went in · leader +0.7 pts, each raider
+0.1". The audit keeps a `pop.rewards` event.

## 8. Failure modes, and what happens

| what goes wrong | what the raid shows | what is recorded |
| --- | --- | --- |
| the leader has more keys than pops recorded and wants another | *Next pop* opens a new window and orders the watcher again | one `raid_pops` row per attempt |
| no free exit / fleet down / trade hold | "no watcher: <reason>"; pop stage runs on the leader's word | `unverified` |
| login queue longer than the AFK check | "watcher queued (n)"; pop stage waits up to 2 min for it, then `unverified` | watcher state, queue position |
| watcher kicked or disconnected mid-trip | retried once inside the window, else `unverified` | `failed (reason)` |
| leader pops before the watcher is in | not seen; if the portal is still up when the watcher arrives it counts (a standing portal is matched on arming) | — |
| leader pops in the other bazaar | no pop seen where announced → `none`, raid ended | on the leader's record |
| someone else pops the same dungeon there | counts as the raid's pop ("popped ✓ by X (not the leader)") | the opener on record |
| leader out of the watcher's sight when they pop | the portal never streams to the watcher, so the pop is not seen; the leader was whispered when they strayed and the card shows "out of the watcher's sight" | `leader.out_of_range` / `leader.in_range` events |
| leader not named when they pop | opener resolved from whoever stood on the spot | flagged "opener by proximity" |
| portal's owner account not sent by the server (to verify live) | same fallback; the label's name if any | the live test settles this |
| raider present in game but under another name | shows as absent; presence is by IGN only | — |
| leader ends nothing | 90 min timeout | `timeout` |
| leader posts and never pops (a fake raid) | the raid ends "no pop" once a watcher has looked; a strike, shown on their card and profile; cooldowns then a block | `raid_strikes`, `strike.no_pop` |
| leader cancels after raiders started moving | a strike (free during headcount) | `strike.cancelled` |
| leader picks a busy server | refused at posting and at the AFK check; the picker greys busy servers out | — |

## 9. Rollout, in order

1. **Live test with rotmgproxy** (docs there): the bazaar world's name, which
   x is "left", OWNERACCOUNTID on a popped portal, MODIFIERS format, portal
   lifetime, whether the whole bazaar is in one view. Fill the findings.
2. **Relay port** (§6) with tests in the relay's harness, plus the dev-console
   button to send a watcher to a bazaar on prod for a few minutes and read
   the roster back. This exercises login, queue, entry and reporting with no
   raid involved.
3. **Site** (§7): migration, Pop stage, fields, hook, UI, notifications,
   history. Ship with the watcher hook disabled (`RAID_WATCHERS` unset):
   every raid runs `unverified`, exactly like today.
4. **Fleet** (§5) behind `RAID_WATCHERS=1`; watch a handful of real raids
   with the dev tab open; then default on.
5. **Later:** a second watcher for the other bazaar when exits are idle,
   Discord mirroring. (Points for verified pops are built, §7c.)

## 10. Open questions, each with its measurement

Answered live on 2026-09-13 (four pops, two raids confirmed end to end):

- **Left bazaar** = the Cloth Bazaar Portal with the smaller x (x=87 vs 127 in the Nexus); the player's and the watcher's "left" landed in the same instance.
- **The bazaar world** is named "Cloth Bazaar" (display "Grand Bazaar", 150 players). It holds a Pet Yard, a Vault and a Nexus portal, all ignored as permanent.
- **The opener is announced by NOTIFICATION, not on the portal.** A key portal's only string stat is its label (the dungeon name); there is no OWNERACCOUNTID and no chat TEXT. The server sends two NOTIFICATIONs in the portal's tick: effect 8 with `{"k":"s.dungeon_opened_by","t":{"player":"Name",}}` (invalid JSON, a trailing comma) and pictureType = the portal type, and effect 6 (`s.opened_by`) with objectId = the opener's object. The watcher pairs them with the portal and names the opener from them; the site takes the leader on the spot (within 2 tiles, the portal spawns at their feet) only as the fallback.
- **Modifiers** arrive on a NEWTICK about 100 ms after the object, as MODIFIERS (121), e.g. `HEALTHYMINIONS_4;DIMITUS;FEROCIOUSMINIONS_4;DUSTSTORM;|S`; the watcher reports the pop again when they land and the site fills them in. Low dungeons may have none.
- **Portal lifetime** is 30 s.
- The relay's own object table is from an old build: the watcher recognises portals from `src/relay/realm/portals.json` (generated from the current game data by `scripts/raid-portals.mjs`) instead.

| question | how it is answered |
| --- | --- |
| Is a whole bazaar inside one view radius (is the roster everyone)? | walk the bazaar's far side with `/px players` open |
| Login/queue time on raid servers at raid hours | the dev-console watcher button, a few evenings |
| Should "pop now" wait for the leader to be seen in the roster? | show it as a hint first ("we don't see you in the bazaar yet"), decide after a few raids |
