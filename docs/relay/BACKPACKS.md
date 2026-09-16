# Backpacks for the communism fleet — the complete design

This is the whole plan for keeping the fleet's trade capacity where it
should be, by itself, using Realm's monthly Backpack rewards. It supersedes
the scheduling parts of the 2026-09-07 notes (`BACKPACKS-notes-2026-09-07.md`,
kept for the verified wire facts and the record of what was tried). Where
this document and the notes disagree, this document wins.

Status (2026-09-07, after the "ship first" deploys, rewrite ae60172): the
scheduler of §4 runs on prod (`BACKPACK_SCHEDULER=1`), with the chore,
login, audit and backstop lanes as specified, the login hook of §5.5, the
retry accounting, the recycle lane of §5.4 (switch off until watched live on
a few accounts), and the §9.1 calibration collecting evidence by itself.
Still to verify live: a recycle trip end to end, the month-reset moment, and
Realm's tolerance for the trip rate. The site's vault caps are operator-set
blocks of 8, not derived from bot capacity, so §6's "site vault caps" item
needs no code: the vault lane equips the bot and the packer fits 16.

---

## 1. Goal and principles

**Goal.** Each pool (seasonal, non-seasonal) and each personal vault has
enough 16-slot bots for its stock plus headroom, at all times, without an
operator pressing buttons — at the smallest cost in game logins, proxy exits
and claimed backpacks, and without ever getting in the way of players.

**Principles, in priority order.**

1. **Players first.** Maintenance yields to deposits and withdraws: it never
   starves the login pool, never holds a bot a player is waiting on, never
   runs during a ban sweep.
2. **Claim as needed.** A claim is sticky to the claiming character's
   seasonality and there is one per account per month, so a backpack is
   claimed only where the plan wants a 16-slot bot. Unclaimed days expire by
   design; a month-end backstop exists but is off unless switched on.
3. **Never lose a backpack.** Equipped ones die with the character, so a
   character wearing one is never deleted; banked ones survive death and
   season resets, so recycling always equips from the chest.
4. **Cheap sensors, expensive actions.** Every ordinary login already reads
   char/list; adding the 3 KB calendar there makes the fleet's picture fresh
   for free. Game logins are spent only on trips that change something.
5. **Restart-safe by construction.** Runs are short batches; all progress is
   in the state file; a restart loses minutes, and the next tick re-plans.
6. **Observable and pausable.** One decision line per tick, a tab that shows
   why the scheduler did or did not act, a switch that stops it without a
   deploy, cancel buttons for anything in flight.

---

## 2. The model the design rests on

### Accounts and characters

- One character slot per account (`MaxNumChars` = 1). A bot's pool **is** its
  character's seasonality. Switching pools means delete + create.
- char/list (HTTP, token only, no `do_login`) tells, per character:
  `BackpackSlots` (8 = wears a backpack), `Seasonal`, `Dead`, `Level`.
  This is the **authoritative** slot count; the in-game HASBACKPACK stat
  reaches few accounts and an empty backpack shows no item, so in-game
  evidence can only ever *add* a backpack, never remove one.
- The Gift Chest is per account **and per seasonality**. A claim lands in the
  chest of the claiming character's side; at season end the seasonal chest's
  contents move to the non-seasonal vault and seasonal characters convert.
- Realm's ban wave: about a quarter of the accounts minted since the cutover
  copy answer "suspended for breaching Terms of Service" on char/list. The
  supply of fresh accounts is unreliable; capacity has to come from the
  accounts we keep.

### The calendar

- `dailyLogin/fetchCalendar` (3 KB): `serverTime`, two tracks
  (non-consecutive, consecutive), each day's `ItemId`/`quantity`, and a
  `key` only on a day that is reached and unclaimed. Backpack = item 3180.
  Which day pays backpacks, and how many, **varies by month**; some months
  have none, some more than one; both tracks are scanned every time.
- The day counter advances on **days the account logged in**. Assumed:
  distinct UTC days, counted when the character enters a world. (Both
  assumptions have a measurement in §9.)
- The calendar resets at the month boundary (assumed 00:00 UTC on the 1st;
  §9 verifies it once). A day left unclaimed at the reset is gone.
- To claim day D an account needs D login days this month. This month D = 2
  (3× Backpack).

### The season

- `season/seasonInfo` (HTTP, any token) gives `{id, name, start, end}`. The
  watcher refreshes it hourly (every minute until first known), and at
  `end` marks every account non-seasonal once per season id, also at boot
  after a downtime across the boundary, also when a refresh already returns
  the successor.
- Current: Retro Winds ends 2026-10-06 09:00 UTC; the calendar resets
  2026-10-01, i.e. the month ends first this time.

### Costs (measured 2026-09-07)

| action | cost |
| --- | --- |
| chore trip (login, quest room claim, vault via the quest room portal, equip, logout) | ≈ 25 s, one exclusive exit; 6 workers ≈ 10 accounts/min |
| login pass entry (login to the Nexus, snapshot, logout) | ≈ 10 s, one exclusive exit |
| char/list | 53 KB response |
| calendar | 3 KB |
| audit of an account (verify + char/list + calendar) | 3–5 s, 60–90 KB, one exit |
| login pool | 100 datacenter exits, 80 enabled, unmetered, shared with trading, one bot per exit |
| residential list | 20,000 usernames on one gateway, metered per GB — audits only, never trips |

### What each bot's state looks like to the fleet

`backpack_state.json` (per account, plus fleet-wide), written atomically,
saves debounced to once per 10 s during runs:

| field | source | meaning |
| --- | --- | --- |
| `seasonal`, `dead`, `charId`, `maxNumChars` | char/list at login or audit | the character |
| `hasBackpack` | char/list (authoritative); confirmed equip; in-game evidence adds | wears one |
| `banked` | VAULTINFO at the last vault visit | spares in this side's chest |
| `held` | tracker | items in trade slots at the last visit |
| `nonconCurDay`, `conCurDay`, `backpackDays[]` | calendar at login or audit | where the account is on the calendar, which days pay backpacks, which are claimable |
| `loginDays[]`, `lastLoginAt` | every bring-up the fleet makes | days counted this month |
| `claimed[]` | chore | `YYYY-MM:track:day` confirmed by CLAIMREWARDRESULT |
| `lastChoreAt`, `choreAttempts` (this month), `lastRecycleAt` | runs | retry accounting |
| `lastError`, `lastErrorAt`, `manual` | runs | why the last attempt failed; `manual` after 3 structural failures |
| `lastAuditAt` | audit or login | freshness |

Fleet-wide: `serverTime`, `season`, `rolledSeasonId`, `samples[]` (daily
stock per pool, 30 days), `scheduler` (last tick, last decision, counters
per day for 30 days, next planned actions), `observed` (calibrations from
§9: reset moment, login-day boundary, whether verify counts as a login).

The tracker (`inventory_state.json`) holds each bot's capacity (8/16) and
holdings; the scheduler only ever writes capacities in **bulk**
(`noteCapacities`), never per bot in a loop — a per-bot change notification
rebuilds the site's whole pool view, which ran prod out of memory once.

---

## 3. Demand: what the plan asks for

`planClaims` is pure and runs whenever anyone asks. Inputs: one row per
usable account (not suspended, not `manual`) with pool, items held,
capacity, whether a backpack day is claimable, whether a spare is banked,
whether the bot is somebody's vault bot. Output per lane: what is needed,
what exists, the deficit, the candidates, the picks.

### Lanes

1. **Vault lane (user-facing, first).** Every personal-storage bot whose
   character has no backpack. A vault bot's capacity is a user's storage
   size (the site allocates vault slots 8 at a time, so 16 slots doubles the
   vault). Picks: all of them, fullest first. No headroom math.
2. **Pool lanes (seasonal, non-seasonal).** Stock S = items on the pool's
   bots that are pool property (vault items excluded, as consolidation does).
   Bots at 16 = B. Headroom H = measured net gain per day × horizon, where
   the horizon is the days until the next time new claims become possible:
   `daysToReset + nextBackpackDay` (default 2 when next month's calendar is
   unknown). Until two days of stock samples exist, H = 20% of S. A shrinking
   pool plans no headroom. Need N = ceil((S + H) / 16); deficit = N − B.
   Picks: the `deficit` biggest holders among candidates.
3. **Equip lane.** Accounts with `banked ≥ 1` and no backpack on the
   character (after a recycle, a death, or an earlier bank-only claim): a
   vault-only trip, no claim needed. These count toward a pool's deficit
   first, since they cost no claim.

### Orders (added 2026-09-10)

A deposit is one trade of a size the player picks, 8 or 16 slots. When a
16-slot deposit waits and no bot the routing would send has 16 free, the
dispatcher places an **order** for that pool half and renews it every pass
until a bot with the room appears or the deposit is gone; an order nobody
renews lapses after 5 minutes, and one that has spent three trips is
dropped. The scheduler serves open orders ahead of every routine lane — one
trip per waiting half, not gated by the chore cadence or the pending-player
yield (the order *is* one of those players), and a routine run in the way is
stopped at its next account. The candidate is an empty, free account of
that half with a spare banked (equip only) or a claimable day (claim, then
equip): empty so it is a 16-free bot the moment the backpack is on. The
site's deposit gate accepts a 16-slot request when such a candidate exists
(`room.<half>.canMake` on the pool payload) and tells the player to allow
a few minutes; that deposit gets 20 minutes before it ages out.

### Candidates

An account is a candidate for a lane when: its character exists and is not
dead; it wears no backpack; it is not online for trading and holds no
assignment; it is not the login desk; `lastErrorAt` is older than 24 h and
`choreAttempts` < 3 this month (else it waits for the next month or the
operator); and for the claim lanes, a backpack day is **claimable now**
(`key` present). Accounts whose day is *reached* but not claimable are not
candidates; accounts whose day is *not yet reached* are the login lane's
business (§5.3).

### Why biggest holders first

Consolidation gathers stock onto the biggest holders. Equipping them turns
their extra 8 slots into usable room immediately, without a single extra
move, and the trip works with a full inventory (the backpack is used
straight out of the chest). Empty accounts get backpacks last; they are
cheap to fill but gain nothing until items flow to them.

### What the plan does not do

It never claims ahead of need, never claims on a suspended or dead
character, never picks an account that the dispatcher is using, never picks
across pools (an account's target pool is its current character's pool;
recycling, §5.4, is the only thing that changes it, and only under §5.4's
rules).

---

## 4. The scheduler

`src/relay/fleet/backpackScheduler.ts`, one tick every 60 s inside the fleet,
started after the startup sweep and the capacity seed, first tick 120 s
after boot. Enabled by `BACKPACK_SCHEDULER=1` **and** `enabled: true` in
`backpack_settings.json` (the tab flips the file; no deploy needed to stop
it). At most **one run is started per tick**, and at most **one run is in
flight at a time**.

### 4.1 Every tick

1. **Refresh clocks.** If the calendar clock is older than an hour and a bot
   is online, fetch the calendar with its token: `serverTime`, and this
   month's backpack days (which days, how many). Season clock is the
   watcher's.
2. **Gather load.** Pending player requests (the dispatcher's last routing),
   online bots, free exits (`exclusiveCapacity − occupied`), whether the
   ban-sweep hold is active, whether the login gate is globally paused.
3. **Decide** (§4.2). Write the decision to the state file's `scheduler`
   block; log it only when it differs from the previous tick's or every
   10 minutes, so a quiet fleet is one line per 10 minutes.
4. **Start** the chosen run, if any, with its batch and concurrency.

### 4.2 The decision, in order

```
if !enabled                      -> "disabled"
if ban sweep hold                -> "ban sweep"
if a run is in flight            -> "running: <kind> <done>/<total>"
if login gate paused             -> "logins paused by Realm (attempt limit)"
if pending players > yieldPending-> "yielding to N pending requests"
if free exits < minFreeExits     -> "only N free exits"

lanes, first that has work wins:
  1. recycle   (enabled && a pool's free slots < critical && recycle picks)   -> recycle batch
  2. chore     (due && plan picks (vault, equip, pool lanes))                 -> chore batch
  3. logins    (in the daily window, or continuous in the last 3 days
               of the month, && feasible targets)                             -> login batch
  4. audit     (due && backlog)                                              -> audit batch
  5. backstop  (opt-in, last 24 h before reset && claimable remain)          -> bank-only chore batch
else                                -> "nothing to do (deficit 0 / no candidates)"
```

Cadence knobs (defaults): `choreEverySeconds` 600, `choreBatch` 100,
`choreConcurrency` 6, `loginHourUtc` 2, `loginBatch` 200,
`loginConcurrency` 10, `auditEverySeconds` 3600, `auditBatch` 500,
`auditConcurrency` 12, `recycleBatch` 20, `recycleConcurrency` 2,
`yieldPending` 5, `minFreeExits` 15, `maxTripsPerHour` 600,
`backstop` false, `recycle` false (until §7 step 6 is verified live).

### 4.3 Month-end and season-end awareness

- **Last 3 days before the reset:** `choreBatch` doubles and the login lane
  runs on every tick (not just the daily window) for accounts whose slack
  (days left − logins still needed) is ≤ 1. The goal is that every pick the
  plan wants this month reaches its day and gets claimed before the reset.
- **Last 24 h:** the backstop lane, if switched on.
- **Season end − 3 days:** pool-lane picks prefer seasonal-pool holders (a
  backpack equipped on a seasonal character converts with it and lands as a
  16-slot non-seasonal bot). After the roll, the seasonal lane's numbers
  start from zero and the non-seasonal lane re-plans with the converts.
- **Between a season's end and the next one's start** (the watcher reports
  the successor): nothing is claimed on a seasonal-bound account; new
  seasonal accounts come from mints or from §5.4 recycling of accounts whose
  claim is still unused this month.

### 4.4 Rate limits and budgets

- `maxTripsPerHour` bounds game logins from maintenance (default 600, the
  chore alone at 6 workers is 600/h).
- Exits: maintenance never takes the last `minFreeExits`; trading bots and
  standby come first. An audit through the login pool counts as exits too.
- LoginGate: any attempt-limit or global pause pauses every lane for
  30 minutes and is logged once.
- A run whose failure rate over the last 20 accounts exceeds 50% cancels
  itself and the scheduler backs off for an hour ("something changed:
  <last error>"). This catches a Realm change (map names, packet ids,
  portal placement) before it burns the roster.

---

## 5. The runs (mechanisms)

All runs are sweep-shaped: one worker per account, claim an exit, bring the
bot up, do the trip, take it down, release; every step has a timeout; the
account sits in the dispatcher's `maintenanceHolds` for the duration (no
trades, no consolidation, no idle disconnect, no wake); the Inventories tab
shows the current step as the bot's status.

### 5.1 Chore trip (exists; amendments marked ★)

1. Bring-up to the Nexus (char/list read on the way: backpack, seasonal,
   dead ★ if dead → record, skip, hand to the recycle lane).
2. ★ Calendar at bring-up (the `onLogin` hook, §5.5) instead of a separate
   fetch; then `decide(state, policy)`.
3. If a backpack day is claimable and the lane is a claim lane:
   GOTOQUESTROOM → wait for the Daily Quest Room → settle 4 s → re-fetch the
   calendar from inside the room → CLAIMDAILYLOGINREWARD per claimable
   backpack day, verdict on CLAIMREWARDRESULT (8 s, one retry), server
   chatter logged → record `claimed`.
4. Vault: the quest room's own Vault Portal when there (else back to the
   Nexus and its portal); walk within 0.8, settle 0.7 s, USEPORTAL, wait for
   the Vault's MAPINFO (6 s, up to 4 attempts with re-walk); VAULTINFO
   sequence → Gift Chest contents → `banked`.
5. Equip when the character has none and a spare is banked: walk within 0.6
   of the chest, settle 1 s, USEITEM the chest slot; success = INVRESULT
   ok=true (the reliable signal), or HASBACKPACK, or the chest slot emptying,
   or "backpack already used" (counts as done, no decrement); INVRESULT
   ok=false = refusal → re-walk and retry once; last resort char/list
   (lags until the character saves).
6. Record: capacity 16 in the tracker (bulk at batch end ★), `hasBackpack`,
   `banked`, `held`, `lastChoreAt`, login day; take down.

★ Failure classes: *transient* (network, kick, no verdict, portal not in
view, "client went inactive") → retry in a later batch, no attempt counted;
*structural* (claim refused, USEITEM refused twice, no Gift Chest in view,
"not applied") → `choreAttempts++`, `lastErrorAt`, 24 h cooldown; three
structural failures → `manual` for the operator's list.

### 5.2 Equip-only trip

Chore trip without step 3, for the equip lane. Same confirmations.

### 5.3 Login pass (exists; targeting ★)

`sweepAccount`: login to the Nexus, wait in world, snapshot, logout;
`noteLogin`. ★ Targets are computed, never the roster: accounts that would
be picks if their day were reached (same ordering as the plan) whose
`nonconCurDay < D` and for which it is still feasible
(`D − nonconCurDay ≤ days left before the reset`, counting today if not yet
logged), capped at the pool's deficit plus a 20% margin and at
`loginBatch`. Tightest slack first. Accounts the dispatcher woke that day
already count (their bring-up records the day), so the pass skips them.

★ If the §9 experiment shows that `account/verify` alone advances the
calendar, the login pass becomes an HTTP call through the audit proxies
(3 KB, no game login, no exit from the login pool) — a 20× cheaper lane.
The scheduler switches on the `observed.verifyCountsAsLogin` flag.

### 5.4 Recycle trip (new)

The only lane that creates capacity without minting. Preconditions, all
checked against a fresh char/list on the trip: non-seasonal (or seasonal
with a day still unclaimed this month — see below), character holds
nothing (tracker and live), wears no backpack, `banked ≥ 1` in **its own
side's** chest (or the character is dead). Steps: `char/delete` →
bring-up creates the new character (the client's CREATE-after-MAPINFO path;
the first CREATE is refused with FAILURE 0 and the retry succeeds, as the
proxy documented) with the **same seasonality** → tutorial if the account
is not `TDone` (assumed not needed on a TDone account; §9) → vault → equip
from the chest → record.

Cross-pool recycling is allowed in exactly one case: the account has **not
claimed this month and has nothing banked on the old side**; then the new
character may be created seasonal, and its claim lands seasonal. This is
how the seasonal pool is rebuilt after a season rollover without waiting for
mints.

Guards that can never be overridden: never delete a character wearing a
backpack; never delete a character holding items; never delete a vault bot
(somebody's property lives on it); never recycle an account the dispatcher
has a client for; at most `recycleBatch` per run and one run at a time.

### 5.5 Audit (exists; incremental ★) and the login hook (new)

★ `FleetDeps.onLogin(acc, client)` after every successful authenticate:
apply char/list (backpack, seasonal, dead), fetch the calendar once per
account per day (3 KB), `noteLogin`, bulk-note the capacity. Every bot the
dispatcher wakes for trading refreshes its own row for free; the audit is
left with accounts the fleet never touches.

★ Audit lane: never-audited first, then rows older than 3 days that no
login refreshed, `auditBatch` per run, through the login pool (or
`BACKPACK_AUDIT_PROXIES_FILE` when set). Retires "suspended" accounts
(`pool.markSuspended` + `gate.retire`); records `dead`; seeds capacities in
bulk at the end of the batch.

---

## 6. Interplay with the rest of the fleet

- **Dispatcher.** `maintenanceHolds` covers claims, consolidation, idle
  disconnects, wakes and standby. The scheduler skips any account with a
  live client or an assignment. When a trip equips a bot, the tracker holds
  16 and the next consolidation plan uses it (offline bots are planned at
  their tracked capacity now); personal-vault items count against capacity
  in planning; a bot found full live is refreshed and backed off 30 min.
- **Collectors.** A collector is held online only while a pending move
  targets it or for 90 s after an arrival, so maintenance does not compete
  with parked bots for exits.
- **Site vault caps.** The site allocates vault slots from the bot's
  capacity; after a vault bot's trip the pool payload shows 16 and the
  allocation may grow. Verify once (§9) that the cap follows.
- **Ban sweep.** Holds trades fleet-wide; the scheduler idles while it runs.
- **Accountgen.** Fresh accounts arrive with a character and an empty
  calendar; they enter the plan through the audit lane or their first
  login. Their ban rate is the reason the recycle lane exists.
- **Season watcher.** Rolls everyone non-seasonal at the season's end; the
  scheduler reads `rolledSeasonId` and the watcher's successor to know it
  is between seasons.

---

## 7. Rollout, in the order that keeps prod safe

Each step is deployable alone, tested, and verified live before the next.
No deploy while a long run is in flight until step 2 lands (after it, runs
are 10-minute batches and a restart is harmless).

1. **Login hook + calendar at login + save debounce.** Tests: the hook
   folds a char/list body and a calendar into the row; the tracker gets one
   bulk note per batch. Live check: a day of ordinary trading refreshes rows
   (`lastAuditAt` moves without an audit). ~half a day.
2. **Scheduler core**: settings file + control-plane route + tab panel,
   tick, decision log, yield rules, chore lane in batches (vault, equip,
   pool lanes), rate limits, self-cancel on failure spikes. Tests:
   table-driven `decide()` over every branch of §4.2 and §4.3; batch
   selection excludes cooled-down, manual, online, assigned accounts; the
   plan's lanes. Live: enable with `choreBatch: 20`, watch two batches, then
   defaults. ~1 day.
3. **Targeted login lane** with the feasibility math and the month-end
   continuous mode. Tests on the arithmetic. Live: watch `nonconCurDay`
   advance the next day for the targets. ~half a day.
4. **Incremental audit lane** (mostly wiring; the audit exists). ~2 hours.
5. **Vault lane** in `planClaims` + the site-cap check. ~2 hours.
6. **Recycle trip** behind `recycle: false`: tests for every guard; live on
   three throwaway accounts (one dead character, one empty non-seasonal
   with a spare, one that must be refused); then enable with
   `recycleBatch: 5`. ~1 day.
7. **Backstop switch** (a filter on the chore lane). ~1 hour.
8. **Calibrations** (§9) run as they come; the flags they set are read by
   steps 2–3.

Total: roughly three working days, most of it tests and live watching.

---

## 8. Observability, controls, and what "healthy" looks like

**Tab (Backpacks).** Scheduler: enabled, last tick, last decision, next
planned action per lane with counts (picks, feasible logins, audit backlog,
recycle candidates), the last 20 runs (kind, when, ok/failed/skipped), and
daily counters for the month (claimed, equipped, recycled, logins, audits,
retired). Plan: per lane, stock, headroom (and how it was derived), at 16,
need, deficit, candidates, the first picks. Roster: audited, with backpack,
banked, claimable, logged today, manual. Buttons: pause/resume scheduler,
run a lane now, cancel the run in flight; the existing manual runs stay.

**Accounts view** filters: `picks`, `needlogin`, `claimable`, `banked`,
`nobackpack`, `manual`, `errors`, `dead`, `vaultbots`.

**Logs.** `backpacks: tick — <decision>` (deduped), one line per trip
summary as today, one line per lane start/finish with totals, one line for
every calibration observation.

**Healthy** means: deficit 0 in every lane most of the time; the daily
counters show claims only when the deficit was positive; no `manual`
accounts piling up; the login lane touching hundreds, not thousands; free
exits never below `minFreeExits` because of maintenance; no scheduler
back-offs.

---

## 9. Calibrations and open questions (each has a cheap measurement)

1. **Does `account/verify` count as a login day?** Audit 20 accounts that
   the fleet never logs in, on two consecutive days; if `nonconCurDay`
   advances, the login lane becomes an HTTP call. The scheduler runs this
   itself during its first two days and sets `observed.verifyCountsAsLogin`.
2. **Login-day boundary.** For accounts logged in both before and after
   00:00 UTC, compare the counter's delta; sets `observed.loginDayBoundary`.
3. **Month reset moment.** The first tick after the month changes compares
   a known account's counter before and after; records `observed.resetAt`.
4. **Site vault caps follow capacity 16.** One vault bot after its trip:
   does the user's cap grow? If not, the site side needs a small change.
5. **Recreated character on a TDone account skips the tutorial.** Checked
   on the first recycle trip.
6. **Realm's tolerance for 600 maintenance logins per hour** from 80
   exits. Watch the login gate's attempt-limit notes during the first days.
7. **Chest scope confirmation** (already answered by the owner: split by
   side) — the design assumes it everywhere.

---

## 10. Failure modes and what the design does about them

| failure | handling |
| --- | --- |
| Realm changes a map name, a packet, portal placement | trip fails structurally on every account → the run's failure-rate breaker cancels it, the scheduler backs off an hour and logs the last error; nothing is claimed blindly |
| claim refused / no verdict | one retry in the room; then structural failure with cooldown; a claim that "succeeds" but the calendar still shows the key is re-read and treated as unclaimed |
| USEPORTAL ignored | settle + up to 4 attempts with re-walk |
| USEITEM refused | re-walk and retry once; "already used" is success without decrement |
| stat 79 / char/list lag | INVRESULT ok=true is the confirmation; char/list only as last resort |
| bans during a run | "suspended" retires the account; the batch continues |
| proxy exhaustion | maintenance never takes the last `minFreeExits`; audits can use a dedicated list |
| login attempt limits | the login gate's pause stops every lane for 30 min |
| out of memory from bulk writes | capacities noted in bulk; pool polls coalesced |
| deploy or crash mid-run | batches of 10 minutes; markers per account; next tick re-plans |
| wrong clocks | no backstop without a month clock; no seasonal special-casing without a season clock; both are refreshed hourly and calibrated |
| a pool starving while accountgen is banned | recycle lane, capped per run, with its guards |
| an operator needs it to stop | settings switch (no deploy), cancel buttons, `BACKPACK_SCHEDULER` env as the hard switch |

---

## 11. One account's life under this design

A fresh account arrives from accountgen with an empty calendar. Its first
login for a deposit refreshes its row (char/list, calendar) for free. It
logs in on two days for trades; the calendar reaches day 2 and the row shows
three backpacks claimable. It holds twelve potions by now, so it is among
the biggest holders of its pool, whose deficit is positive: the next chore
batch picks it. The trip claims three backpacks in the quest room, walks
through the room's vault portal, uses one from the chest, banks two. The
tracker records 16; the next consolidation plan gathers more stock onto it.
Months pass; its character dies in a stray kick? No — bots never leave the
Nexus, but suppose the character is deleted by an operator: the recycle
lane sees a non-seasonal account with two spares and no character, creates
one, equips a spare, and the bot is back at 16 within a minute. At season
end nothing happens to it (non-seasonal). Had it been seasonal, the watcher
would have flipped it non-seasonal at the season's end and its spares would
have moved to the non-seasonal vault, still usable by the recycle lane.
