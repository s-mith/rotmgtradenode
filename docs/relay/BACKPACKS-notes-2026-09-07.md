> Historical notes. The plan, chore, orders and lanes described here were removed on 2026-09-22; `BACKPACKS.md` describes what runs now (per-account claim and use, the daily login). The measurements and packet behaviours below still hold.

# Backpacks for the communism fleet

Plan drafted 2026-09-07, revised the same evening after live probes. Goal:
get 16-slot Backpacks onto communism bots so each bot holds twice the
inventory, then make consolidation, disposability, and the month/season
calendar treat capacity as a per-bot fact.

This is a plan, not shipped code. It reuses the mechanics already proven in
`rotmgproxy` (`/px questroom`, `/px claim`, `/px vault`, `/px backpack`) and
the primitives already in `src/relay` (GameClient walking, INVSWAP/USEITEM,
the pure consolidation planner). Nothing here needs the proxy at runtime; the
proxy was the test rig that established the wire facts below.

## 0. Facts verified live on 2026-09-07 (read-only HTTP, no game login)

| Fact | Evidence |
| --- | --- |
| **Season clock is an HTTP call.** `POST https://www.realmofthemadgod.com/season/seasonInfo` with `accessToken` returns JSON `{id, name, start, end, popupData, archiveData, forceShowFlag}`; `start`/`end` are epoch seconds. 400 without a token. | Endpoint name from the him.is string table (`builds.him.is/latest/stringliteral.json`, alongside the client log line "Season end timestamp : "). Called live for a rotmglearn account. |
| **Current season:** "Retro Winds", start 2026-08-04 09:00 UTC, **end 2026-10-06 09:00 UTC.** `season/bpInfo` (battle pass) and `missions/getClientSeasons` (`endDate`) agree on the end. | Same call. |
| **Calendar month resets before this season ends.** Month rollover 2026-10-01 00:00 UTC (assumed midnight UTC; confirm by polling `fetchCalendar` across the boundary once), season end 2026-10-06. | `dailyLogin/fetchCalendar` `serverTime`. |
| **This month's backpacks:** non-consecutive track **day 2 = 3x item 3180 (Backpack)**. No other backpack day. | `fetchCalendar` for two accounts. |
| **Login days already accrue on their own.** rotmglearn account 0 shows `nonconCurDay=3` with days 1-3 all still carrying a claim `key` (reached, never claimed). Ordinary logins count; only the *claim* is missing. So unclaimed backpacks are already sitting on fleet accounts that logged in on two distinct days this month. | `fetchCalendar`. |
| **`char/list` does NOT show the vault or Gift Chest.** Checked on a fresh account and on `puppygrrrl` (has a backpack): no `Vault`/`Gifts` element either way. It does give, per character, `BackpackSlots` (8 with a backpack, 0 without), `Seasonal`, `Dead`, `Level`; per account `MaxNumChars`, `NextCharSlotPrice`, `DLDLogin`, `Timestamp`. Gift Chest contents still need a vault visit (`VAULTINFO`). | Saved XML, two accounts. |
| **One character slot per account** (`MaxNumChars` = 1 on both probed accounts). A bot's pool (seasonal / non-seasonal) *is* its one character's seasonality; switching pools means delete + create. | `char/list`. |
| **Packet 108 `NEWCHARACTERINFORMATION` is not the season clock.** It is a single length-prefixed string, `charXML` (the new character's XML block). Drop it as a research lead. | him.is `protocol.json`. |
| **Early conversion exists:** outgoing packet **`ConvertSeasonalCharacter` id 154, zero fields**, driven by the vault's "Character Changer LF" object (`0x1946`, class `SeasonalitySwitcher`); the client string `Season.unseasonCharacterDc` suggests the conversion disconnects the character. Relay has no codec for 154. Unverified live. | him.is `protocol.json`, `stringliteral.json`, `object.xml`. |

Probe script used: `~/.claude/jobs/e3033f48/tmp/probe.ts` (login with a
rotmglearn or roster account, POST any path, save the body). Worth moving
into `scripts/` as `realm-probe.ts` when the codecs land.

## 1. Why

- A Backpack (item `0xc6c` = 3180) adds 8 inventory slots, taking a bot from
  8 usable trade/storage slots to 16. Doubling capacity halves the number of
  bots needed to hold the pool: fewer logins, less proxy pressure, denser
  consolidation.
- Backpacks are rationed **per account per month** by the daily-login
  calendar (three this month). Every account can claim its own, so across
  13k accounts the fleet-wide supply is large; the constraint is *claiming
  before the month resets* and *having logged in on enough distinct days*.
- With one character slot per account, one backpack goes on the character and
  the rest bank in the Gift Chest, which survives character death. That is
  what makes characters disposable and backpacks durable.

## 2. What already exists (do not rebuild)

- **The four steps, proven on the wire** (see `rotmgproxy/README.md` and its
  plugins): go to the Daily Quest Room (`GOTOQUESTROOM`, id 48), fetch and
  claim login days (`dailyLogin/fetchCalendar` HTTP + `CLAIMDAILYLOGINREWARD`
  id 3, verdicts on `CLAIMDAILYLOGINRESPONSE` id 93 and `CLAIMREWARDRESULT`
  id 237), enter the vault (`USEPORTAL` on the Vault Portal `0x0720`), read
  the Gift Chest (`VAULTINFO` id 117), and apply a backpack with `USEITEM`
  addressing the chest's slot object (no free inventory slot needed).
- **GameClient can already walk for real.** It has `setPath` / `moveTo`,
  `findPath` + `smoothPath` (`relay/client/pathfinding.ts`), a
  `WorldState` with object positions, and `USEPORTAL`/`INVSWAP` senders. The
  reference for "walk to an object and use it."
- **Per-bot capacity is already modelled.** `playerData.hasBackpack` is
  evidence-based (stat `HASBACKPACK` = 1, or an item seen in a backpack
  slot). `inventoryTracker` keeps a per-bot `capacity` map. The pure
  consolidation planner (`planMoves`, `collectionTargets`, `fragmentation` in
  `potionConsolidation.ts`) already takes a per-bot `capacities` record and
  ranks collectors by real free room. The algorithm is ready for mixed 8/16
  fleets; the bug is only that one global switch overrides it (§7).
- **Character admin over HTTP:** `char/list` (read-only, token only) and
  `char/delete` (works on the character being played) are proven in
  `rotmgproxy/src/plugins/charadmin.ts`; the fleet already sends `CREATE`
  after `MAPINFO` (needs the 5th bool = `isSeasonal`).

## 3. Protocol gaps to port into `src/relay`

Port the proxy's codecs from `rotmgproxy/src/packets.ts` into
`src/relay/protocol/packets.ts`, with byte-for-byte fixtures where possible:

| Packet | id | Source of truth |
| --- | --- | --- |
| `VAULTINFO` | 117 | proxy `packets.ts` (compressed-int lists, raw tail) |
| `CLAIMREWARDRESULT` | 237 | proxy `packets.ts` |
| `CLAIMDAILYLOGINREWARD` | 3 | proxy `packets.ts` (claimKey, claimType) |
| `CLAIMDAILYLOGINRESPONSE` | 93 | proxy `packets.ts` (message) |
| `GOTOQUESTROOM` | 48 | empty body |
| `CONVERTSEASONALCHARACTER` | 154 | him.is protocol.json: outgoing, zero fields (optional, §8) |

HTTP clients to add next to `getCharList` in `realm/api.ts`, all token-only:
`fetchCalendar` (port from `rotmgproxy/src/plugins/dailylogin.ts`),
`getSeasonInfo` (`season/seasonInfo`, JSON), `deleteChar` (`char/delete`),
and a richer `char/list` parser that returns per-character `BackpackSlots`,
`Seasonal`, `Dead` plus `MaxNumChars`.

## 4. New module: the backpack chore

A maintenance routine in the shape of the existing sweeps (`sweeps.ts`
`startupSweep` / `BanSweep`): claim an exit IP, bring the bot up, drive it
through the sequence, take it down. One account at a time per worker, a
small concurrency cap, staggered like the ban sweep.

Sequence for one account (all real, no spoofing):

1. **Reach the Nexus** (normal bring-up; the char loads into the Nexus).
2. **Daily claim.** Fetch the calendar over HTTP. For every keyed day whose
   `ItemId` is 3180, send `GOTOQUESTROOM`, wait for the Daily Quest Room
   `MAPINFO`, then `CLAIMDAILYLOGINREWARD`; confirm on
   `CLAIMREWARDRESULT.success`. (Claiming from the quest room was the
   verified-working path.) Claim the cheap non-backpack days too while there.
3. **Enter the vault.** From the Nexus, `findPath` to the Vault Portal
   `0x0720`, walk there, `USEPORTAL`; wait for the Vault `MAPINFO`.
4. **Read the Gift Chest.** Wait for the `VAULTINFO` sequence; find the Gift
   Chest object (the one `VAULTINFO` names, never the Temporary Gift/spoils
   chest `0x2944`). Count Backpacks in it. This is the only source of the
   banked count (§0: `char/list` does not carry it).
5. **Apply a backpack** only when the policy says so (§5): the character has
   no backpack (`playerData.hasBackpack` false) and the chest holds one. Walk
   to the chest, `USEITEM` on its Backpack slot, wait for `HASBACKPACK` = 1.
   Otherwise leave it banked.
6. **Snapshot and take down.** Record capacity (16 or 8) and the banked count
   into the tracker, exactly as the startup sweep records inventory.

Verify each step against the same signals the proxy waits on (arrival
record, `VAULTINFO`, the inventory/`HASBACKPACK` stat) with a per-step
timeout, so a stuck chore ends cleanly instead of hanging a bot.

Factor the walk-to-object-and-use helper so it is shared with any future
"walk somewhere and interact" chore.

**Cost estimate.** Login + quest room + vault + take-down is on the order of
a minute per account. At the ban sweep's concurrency the whole roster is a
few hours per pass, so a month-end pass across every account is affordable;
plan for two passes (equip pass early, claim backstop late).

**Distinct login days.** Day 2 needs logins on two distinct days in the
month. Bots the dispatcher already cycles reach that on their own; dormant
accounts do not. Track per account the calendar's `nonconCurDay` from the
audit sweep and schedule a cheap wake (login, no chore) for accounts short of
the needed day count, at least two days before the month resets.

## 5. Disposability and the bot lifecycle

Rules from the account owner, encoded as policy:

- A character with **no backpack equipped and an empty inventory is
  disposable**: nothing of value is lost by deleting it.
- A **non-seasonal** character is disposable **as long as the account's Gift
  Chest holds a Backpack**, because a fresh character can be created and the
  banked backpack applied (§4 step 5). The backpack, not the character, is
  the asset.
- Therefore **bank backpacks; treat characters as fungible.** Equip one on a
  character only when that character needs 16 slots now (it is a collector,
  or holds / is about to hold more than 8 items) or when the season plan
  says so (§8).

With `MaxNumChars` = 1, "disposable" concretely means: `char/delete`, then
`CREATE` with the wanted seasonality, then (if the policy wants 16 slots)
the §4 apply step. That is the fleet's lever for moving an account between
the seasonal and non-seasonal pools.

**Per-account state to keep** (§9): character seasonal flag, character has
backpack, banked backpack count, inventory count. Disposable = `!hasBackpack
&& inventoryEmpty` OR `!seasonal && banked > 0 && inventoryEmpty`. Only the
dispatcher's delete policy may act on it, and it must re-read `char/list`
right before deleting.

## 6. Monthly claim scheduling

- The calendar resets each month. `fetchCalendar` returns `serverTime`,
  `conCurDay`/`nonconCurDay`, and per day `Days`, `ItemId` (+`quantity`),
  `Gold`, and a `key` only on a day that is reached and unclaimed. Scan both
  tracks for `ItemId` 3180 every time; some months have more than one
  backpack day.
- **Schedule.** A fleet-internal monthly job keyed off the calendar's
  `serverTime` (a dispatcher timer, or a Railway cron hitting the control
  plane):
  1. **Early pass** (as soon as the backpack day is reached, from about day 3
     of the month): run the §4 chore on accounts that (a) hold items or are
     collectors (they benefit from 16 slots immediately) and (b) are
     seasonal-pool accounts when §8 says to equip.
  2. **Backstop pass** (last 3 days before the reset): claim on every
     account with a keyed backpack day, bank only, no vault visit needed
     except to count. Never let a backpack day expire unclaimed.
  3. **Wake pass** (two or more days before the backstop): plain logins for
     accounts whose `nonconCurDay` is below the backpack day.
- `char/list`'s `DLDLogin` element is probably the "logged today" marker;
  check it against `nonconCurDay` once and, if it matches, use it to skip
  accounts that already counted a login today.

## 7. Consolidation with mixed capacity

The planner is already per-bot-capacity-correct. The change is upstream:
**stop forcing a single global capacity.**

- Today `PoolSettings.poolHasBackpack` (one boolean in `pool_settings.json`,
  toggled from the dev console) makes every bot report 16. The read paths
  are exactly five: `fleet.ts:62` (tracker constructor), `stores.ts:121`
  (the getter), `sweeps.ts:36` and `:88` (snapshot capacity),
  `inventoryTracker.ts:318-324` (`capacities()` / `capacityFor`), and
  `dispatcher.ts:318` (`capacityFor` for online bots). With only some bots
  carrying backpacks it over-reports capacity, and consolidation plans moves
  into slots that do not exist, which surfaces as refused trades.
- **Change:** make capacity strictly per-bot and evidence-based. Retire the
  global override (keep it only as a one-way migration: when it is on at
  boot, seed the tracker's per-bot capacity to 16 for bots that have shown a
  backpack, then turn it off). Online bot: `playerData.hasBackpack ? 16 : 8`.
  Offline bot: the tracker's last verified per-bot capacity, default 8. Feed
  that map into `planMoves(inventories, caps, ...)`, `collectionTargets`, and
  `fragmentation`, which already take it (`dispatcher.ts:1154`, `:1742`,
  `:1765`, `:1946`, `:1972`).
- **Roles fall out of free room.** 16-slot bots win collector/taker roles
  (more `roomFor`); 8-slot bots are givers and are drained toward empty.
  That dovetails with §5: a consolidation that empties an 8-slot bot makes it
  disposable, and the §4 chore can then give it a backpack (or the delete
  policy can recycle it). Add a small collector tie-break for backpack bots
  in `DEFAULT_WEIGHTS` only if measurement shows room-ranking is not enough.
- **Verify capacity before the trade**, as today: a taker whose backpack is
  gone (deleted char, converted season, stale tracker) falls back to 8 and
  re-plans instead of overfilling. The trade layer already re-checks taker
  room before the trade (post-cutover fix); keep that.
- **Feed the chore from consolidation.** The planner's collector election is
  the natural priority list for the early pass (§6): equip collectors first,
  since every extra collector slot removes a giver hop.
- **Test:** a `potionConsolidation` case with a mixed 8/16 fleet asserting
  that 16-slot bots collect, 8-slot bots empty, and no move exceeds a bot's
  own capacity; a dispatcher test that the per-bot map, not a global flag,
  reaches the planner.

## 8. Season end

Facts from the account owner and from §0:

- At season end, **seasonal characters convert to non-seasonal**, and the
  **seasonal Gift Chest contents transfer to the non-seasonal vault.** A
  backpack banked during a season is not lost; it lands on the non-seasonal
  side.
- Seasonal and non-seasonal are **separate pools** (POLICIES §7). Capacity per
  pool matters independently.
- **The clock is known:** `season/seasonInfo.end`. Cache it fleet-wide
  (one call per hour with any bot's token) and expose `seasonEndsAt` and
  `monthResetsAt` (from `fetchCalendar.serverTime`) on the control plane.
  Keep an env override for both as an emergency fallback.

**One live test decides the rollover strategy.** Unknown: can a *seasonal*
character take a backpack out of a Gift Chest that was filled while the
account was non-seasonal (the client has a separate "headerSeasonal" gift
panel, so the chests may be split)? Test with the proxy on a throwaway
account: bank a backpack on a non-seasonal char, `/px makechar seasonal`,
`/px vault`, `/px gift`. Then:

- **If the chest is account-wide** (the earlier live impression): claim
  every backpack as early as possible regardless of season. After rollover,
  the seasonal pool is rebuilt by recycling disposable accounts into seasonal
  characters (§5) and equipping from the chest.
- **If the chests are split:** the claim's *timing* decides which side the
  backpack lands on. For accounts destined for the seasonal pool, when
  `seasonEndsAt < monthResetsAt` **defer the claim** until after the season
  ends, recreate the character as seasonal, then claim and equip, keeping at
  least one day of margin before the month reset. When
  `monthResetsAt < seasonEndsAt` (this month: Oct 1 vs Oct 6) claim before
  the reset no matter what; it converts to the non-seasonal side at season
  end, which beats losing it.

**Before conversion** (either branch): equip backpacks on seasonal characters
that hold items, so they arrive on the non-seasonal side already at 16
slots. **After conversion:** run the audit sweep (`Seasonal` flips to false
in `char/list`), refresh per-bot capacity and pool membership, re-plan
consolidation on the enlarged non-seasonal side, and start rebuilding the
seasonal pool to its target size via §5 recycling.

**Optional lever:** `ConvertSeasonalCharacter` (154) converts one character
on demand mid-season (from the vault's Character Changer). If it works from
the fleet, pool rebalancing seasonal to non-seasonal no longer needs delete +
create. Verify live before relying on it; the client hints it disconnects the
character.

## 9. State / schema additions

- Per account (persist alongside the pool): `seasonal` (already there),
  `charHasBackpack`, `backpacksBanked` (from the last vault visit),
  `lastVaultAuditAt`, `calendar: {month, nonconCurDay, claimedBackpackDays}`,
  `lastCalendarCheckAt`.
- Fleet-wide: `seasonEndsAt`, `seasonName`, `monthResetsAt`, refreshed hourly.
- Reuse `inventoryTracker`'s per-bot `capacity` as the single source of a
  bot's slot count; drop the global-override read paths (§7).
- No new site tables for phase 1; the chore is fleet-internal maintenance.

## 10. Rollout and verification

1. **Codecs + HTTP clients** (§3) with fixtures; typecheck and existing relay
   tests green. Include `getSeasonInfo` and the richer `char/list` parser.
2. **Per-bot capacity** (§7): remove the global override, feed per-bot
   capacities into consolidation, add the mixed-fleet tests. Shippable on
   its own and de-risks everything after.
3. **Read-only audit sweep:** `char/list` + `fetchCalendar` + `seasonInfo`
   per account, no game login: per-account backpack/seasonal/day-count and
   the two clocks. Verify against a couple of known accounts (the roster's
   `puppygrrrl` shows `BackpackSlots` 8).
4. **The chest-scope live test** (§8) with the proxy on a throwaway account.
   It is cheap and it fixes the rollover design.
5. **Backpack chore** (§4) behind a flag, dry-run first (log what it would
   do), then live on a handful of throwaway accounts; confirm `HASBACKPACK`
   = 1 and that consolidation routes into the new slots.
6. **Monthly scheduler** (§6) and **season logic** (§8) last, once the chore
   is trusted.

**Deadline for this month:** the three backpacks per account expire at the
calendar reset on 2026-10-01. Even if only steps 1, 3 and a minimal claim
path from 5 land, run the backstop claim pass before then; banked backpacks
carry over and everything else can follow.

## 11. Open questions for the owner

- Chest scope (§8): run the one live test, or confirm from experience whether
  a seasonal character can pull from a backpack banked non-seasonally.
- Delete policy: may the fleet delete a character that meets the
  disposability rule automatically, or does deletion stay manual at first?
- Target sizes: how many bots should the seasonal pool keep after each
  rollover, and should both pools be grown to 16 slots or the non-seasonal
  side first?
- Month reset instant: confirm it is 00:00 UTC on the 1st (poll
  `fetchCalendar` across the boundary once).

## 12. Shipped on the `backpacks` branch (2026-09-07)

Everything below is on the branch and unit-tested; the in-game trip is NOT
yet run against the live game (see "Live checklist").

- **Codecs** (§3): `GOTOQUESTROOM`, `CLAIMDAILYLOGINREWARD`,
  `CLAIMDAILYLOGINRESPONSE`, `CLAIMREWARDRESULT`, `VAULTINFO`,
  `CONVERTSEASONALCHARACTER`, with round-trip fixtures.
- **HTTP clients** (`src/relay/realm/api.ts`): `getCharListDetail`,
  `fetchCalendar` + `backpackDays`, `getSeasonInfo`, `deleteChar`.
- **Per-bot capacity** (§7): the pool-wide `pool_has_backpack` knob is inert;
  tracker, sweep and dispatcher size each bot from its own evidence. Mixed
  8/16 planner tests added.
- **Chunked withdraws** (new, owner's request): a bot hands a withdraw over in
  as many trade windows as the withdrawer's free inventory slots require
  (`partnerFreeSlots` from `TRADESTART`, 4 equipment entries then 8 or 16
  inventory entries). Each window offers at most that many items; the same
  assignment re-requests the trade after the partner cooldown; the outcome
  reports the total. A failure after a finished window carries what crossed,
  the dispatcher reports it, and `queue.fulfillWithdraw` credits the delivered
  items and re-opens the row as `pending` with the remainder (items and, for
  pinned rows, instance ids). A window the partner has no room for is
  cancelled with "partner inventory full".
- **Backpack service** (`src/relay/fleet/backpacks.ts`, state in
  `<dataDir>/backpack_state.json`, control plane under `/backpacks`):
  - `POST /backpacks/audit {limit?, guids?}`: HTTP-only per-account audit
    (char/list, calendar, season clock). `GET /backpacks` for clocks +
    summary + run states; `GET /backpacks/accounts?only=claimable|nobackpack|banked|needlogin|errors`.
  - `POST /backpacks/logins {limit?, guids?}`: the **daily login pass**. The
    owner confirmed accounts must log in each day to receive rewards, so the
    calendar's day counter only advances on login days. The pass brings each
    account not yet counted today (UTC) into the Nexus once via the sweep's
    login routine and records the day; the chore counts as a login too. Run
    it daily until every account has reached the backpack day.
  - `POST /backpacks/chore {mode: "dry"|"live", limit?, guids?, equip?}`:
    the in-game trip. `dry` logs in, reads the calendar, walks to the vault,
    reads the Gift Chest and logs what `live` would do. `live` also claims
    backpack days from the Daily Quest Room and, with `equip: true`, uses a
    banked Backpack on a character that has none. Live mode is refused
    unless the fleet runs with `BACKPACK_CHORE_LIVE=1`. Accounts under the
    chore sit in the dispatcher's `maintenanceHolds` (no claims, no
    consolidation, no idle disconnect).
  - Env: `BACKPACK_AUDIT_CONCURRENCY` (4), `BACKPACK_LOGIN_CONCURRENCY` (10),
    `BACKPACK_CHORE_CONCURRENCY` (2), plus `_STAGGER_MS` for each.

**Live checklist (in this order, a few throwaway accounts first):**

1. `POST /backpacks/audit {"limit": 5}` then `GET /backpacks`: confirm the
   clocks (season end 2026-10-06 09:00 UTC, month reset 2026-10-01) and the
   per-account rows match what you see in game.
2. `POST /backpacks/logins {"limit": 5}` on two different days; watch
   `nonconCurDay` advance in the next audit. This pins down whether a plain
   Nexus login counts (expected yes: that is how the rotmglearn accounts
   reached day 3).
3. `POST /backpacks/chore {"mode": "dry", "limit": 2}`: confirms the walk to
   the Vault Portal, the `USEPORTAL`, and the `VAULTINFO` read. If the
   portal is not in view from spawn, the trip fails with "waiting for the
   Vault Portal in view" and needs a walk toward it first (the proxy
   spoof-walked, so this is the one step without a live precedent).
4. `BACKPACK_CHORE_LIVE=1`, then `{"mode": "live", "limit": 2}` (claim only),
   then `{"mode": "live", "limit": 2, "equip": true}` on a character without
   a backpack; verify `HASBACKPACK` and that consolidation starts routing
   into the new slots.
5. The chest-scope test from §8 (proxy: bank non-seasonal, make a seasonal
   char, `/px gift`), which decides whether claims are ever deferred.

Still open from the plan: the monthly scheduler (§6) and the season-end
logic (§8) are operator-driven for now (run the audit, the login pass and
the chore by hand or from a Railway cron hitting the control plane); the
automatic delete/recreate policy (§5) is not implemented — `isDisposable`
exists as a pure helper only.

## 13. Claim policy, settled with the owner (2026-09-07 evening)

Facts confirmed by the owner:

- **A claim lands in the Gift Chest of the claiming character's seasonality.**
  Chests are split by side. A backpack claimed on a non-seasonal character can
  never serve a seasonal character on that account, and once the month's day
  is claimed there is no second claim. The side an account claims on is
  therefore sticky for the month.
- **Accounts must log in each day** for the calendar to advance (§12, login
  pass).

Policy: **claim as needed, per pool.** Backpacks are not hoarded. Each pool
(seasonal / non-seasonal) needs only as many backpack bots as it takes for
the pool's whole stock to fit on them at 16 slots, plus a buffer (20% of the
stock by default). `planClaims` (`backpacks.ts`) computes, per pool, the
stock, the bots already at 16, the bots needed, the deficit, and picks that
many accounts among those whose character has no backpack and whose day is
claimable, biggest holders first (consolidation gathers stock onto them). The
chore run with `{"plan": true}` claims **and equips** on exactly those
accounts; `GET /backpacks/plan?buffer=0.2` shows the plan without acting.

Consequences for the lifecycle:

- Never recreate an account across pools once it has claimed this month; a
  non-seasonal character with spares banked non-seasonally is recreated
  non-seasonal (the disposability rule). Never delete a character wearing a
  backpack (it dies with it).
- Grow the seasonal pool from accounts whose claim is still available (fresh
  accounts held back): create the seasonal character
  first, daily logins until the backpack day, then claim + equip in one trip.
- Unclaimed days expire at the month reset by design; there is no automatic
  month-end backstop. Run `{"mode":"live","guids":[...]}` by hand if a
  specific account's spares are wanted.

Local roster on 2026-09-07 after the first live runs: non-seasonal stock 383
items on 83 bots, 59 bots already at 16 slots, 29 needed → deficit 0, so the
plan claims nothing more. 31 accounts were claimed on before this rule
(27 in the interrupted bulk pass + 4 single runs); their backpacks sit in
non-seasonal chests and stay useful for non-seasonal recreations.

**Headroom from measured growth (owner, same evening).** The buffer is not a
fixed fraction once there is data: the store samples each pool's stock once
per UTC day (whenever the plan or the audit runs), `gainPerDay` is the net
change per day over the last 7 days of samples, and the plan's headroom is
that gain times the days until the month reset (the next chance to claim).
A shrinking pool plans no headroom. With fewer than two days of samples the
20% fraction applies. `GET /backpacks/plan` reports `bufferItems`,
`bufferMode`, `gainPerDay`, `horizonDays` and the samples. Run the audit (or
the plan) daily so the series exists when the decision matters.

**Season rollover is automatic (2026-09-07).** `src/relay/fleet/seasonWatch.ts`
follows Realm's clock: hourly `season/seasonInfo` with any online bot's token,
a check every minute, and one `markAllNonseasonal()` per season id the moment
the end passes — also at boot after a downtime across the boundary, and when
a refresh already returns the next season. State (`rolledSeasonId`) lives in
`backpack_state.json`; `GET /backpacks` shows `seasonWatch`. The dev console's
"Mark all accounts non-seasonal" button and its `/api/dev/mark-nonseasonal`
and `/accounts/mark-nonseasonal` routes are gone.

## 14. Making it dynamic (plan, 2026-09-07 late)

Today every routine is one-shot: started from the Backpacks tab, walks the
accounts chosen at that moment, stops, and dies with any restart. Only the
season watcher is automatic. This section turns the whole thing into a
scheduler that keeps the fleet at the plan's target by itself.

### What the live runs established (inputs to the design)

- **Trip cost.** One chore trip is ~25 s; six workers do ~10 accounts/min
  through the shared login pool (100 datacenter exits, 80 enabled, one bot
  per exit). 3,706 accounts ≈ 6 h. The chore competes with trading bots for
  exits, so it must yield to player work.
- **Login is the cheap sensor.** char/list is parsed at every login now
  (BackpackSlots → `knownBackpack` → tracker), and the calendar is a 3 KB
  call. Fetching the calendar at bring-up too makes every ordinary login a
  free audit row; the standalone audit is then only for accounts that never
  log in (and for retiring banned ones).
- **Bans.** ~1 in 4 accounts minted since the cutover copy is banned; the
  audit retires them. Pool growth is therefore unreliable,
  which makes recycling (delete an empty character, create one, equip a
  banked spare) the durable way to add capacity.
- **State.** `backpack_state.json` already carries, per account, claim
  month/day, backpack on, banked count, login days, last audit, last error;
  fleet-wide the season clock, stock samples and the rolled season. Runs
  keep only in-memory progress — the one thing a restart loses.
- **Clocks.** Month reset 00:00 UTC on the 1st (calendar `serverTime`),
  season end from `season/seasonInfo` (watcher). This month the reset comes
  first (Oct 1 vs Oct 6).

### The scheduler (`src/relay/fleet/backpackScheduler.ts`)

One 60 s tick inside the fleet, enabled by `BACKPACK_SCHEDULER=1` and by a
switch in `backpack_settings.json` (so the tab can pause it without a
deploy). Every tick evaluates, in order, and starts at most one run:

1. **Yield.** Do nothing while the ban sweep holds trades, while a chore,
   audit or login run is active, while pending player requests exceed
   `BACKPACK_YIELD_PENDING` (default 5), or while free exits
   (`proxies.exclusiveCapacity() - online`) are below
   `BACKPACK_MIN_FREE_EXITS` (default 15).
2. **Season/month state.** From the store: `monthResetsAt`, `seasonEndsAt`,
   `daysToReset`. Refresh the calendar clock from any online bot's token
   hourly (same trick as the season watcher).
3. **Chore, plan-driven, in batches.** Every `BACKPACK_CHORE_EVERY_S`
   (default 600): read `planClaims`; if a pool's deficit > 0, start a live
   chore on the plan's picks capped at `BACKPACK_CHORE_BATCH` (default 100),
   skipping accounts with a `lastError` newer than 24 h and accounts
   already claimed this month. Short batches are restart-safe: a restart
   loses at most one batch, and the next tick re-plans from the state file.
   Equip is always on (the whole point of the pick).
4. **Login pass, targeted and daily.** Once a day (`BACKPACK_LOGIN_HOUR_UTC`,
   default 02): bring in accounts that are *potential* picks but not yet
   candidates — no backpack, in a pool with a deficit, `nonconCurDay` below
   the backpack day, not logged today — capped at the deficit plus a 20%
   margin, biggest holders first. Never the whole roster.
5. **Audit, incremental.** Every hour: accounts never audited, then the
   oldest audit rows beyond 3 days, in batches of 500, through the login
   pool. Retires banned accounts. Skipped entirely when logins already
   refreshed the row that day (see "login is the cheap sensor").
6. **Month-end backstop (opt-in, default off).** In the last 24 h before the
   reset, when `backstop: true` in settings: bank-only claims on accounts
   whose day is claimable, non-seasonal pool first. Off by default per §13.
7. **Season boundary.** Between `seasonEndsAt` and the next season's start
   (watcher tells), do not pick seasonal-bound accounts; after the roll all
   accounts are non-seasonal anyway. Nothing else special.

### Piggybacking on logins (`bringUp` hook)

`FleetDeps.onLogin?(acc, client)` called after authenticate: the backpack
service records `noteLogin`, applies `client.charHasBackpack`, and fetches
the calendar (3 KB) once per account per day to refresh `backpackDays` /
`nonconCurDay`. Cost: one small request per login; benefit: the plan's
inputs are always fresh for every account the fleet touches.

### Recycling (the answer to a starved pool)

`recycle` run, plan-driven like the chore, only when a pool's free slots
fall under `freeSlotsTarget` and nothing is ready: pick
accounts the disposability rule clears — non-seasonal, empty, character
without a backpack, `banked >= 1` — and per account: verify with char/list,
`char/delete`, `CREATE` with the same seasonality, walk to the vault, equip
from the chest, record. Small concurrency (2), hard guards: never delete a
character that wears a backpack or holds anything; never recreate across
pools (§13). This is the one piece that adds capacity without minting.

### Persistence and resume

- Per-account markers already exist; add `lastChoreAt` and `lastRecycleAt`.
- The scheduler writes its last decision per tick (`why it did / did not
  start a run`) into the state file's `scheduler` block; the tab shows it.
- On boot the scheduler starts after the startup sweep and the capacity
  seed, and simply re-plans; no in-flight run is resumed, batches are the
  unit of loss.

### Settings and controls

`backpack_settings.json` (control plane `/backpacks/settings`, tab
switches): `enabled`, `choreBatch`, `choreEverySeconds`, `loginHourUtc`,
`backstop`, `recycle`, `yieldPending`, `minFreeExits`, `buffer` (fraction
fallback). Env vars of the same names as defaults. Cancel buttons stay.

### Order of work

1. `onLogin` hook + calendar-at-login (cheap, makes everything else accurate).
2. Scheduler with chore batches + yield rules + settings + tab status.
3. Targeted daily login pass.
4. Incremental audit.
5. Recycle run (needs the delete/create trip; test on throwaway accounts first).
6. Backstop switch.

Each step deploys on its own; steps 1–2 give the "keeps itself at target"
behaviour. Do not deploy while a long chore run is in flight (it dies with
the restart): the batch design in step 2 removes that constraint afterwards.
