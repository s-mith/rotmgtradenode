# Backpacks — how the node handles them

Written 2026-09-22, replacing the plan-and-chore design of 2026-09-07 (kept
as history in `BACKPACKS-notes-2026-09-07.md`). Source: `src/relay/fleet/backpacks.ts`.

## 1. What a backpack is to the node

A Backpack (item 3180) gives a character 8 more trade slots: 16 instead of 8,
so one trade carries twice as much. It is the daily-login calendar's reward:
claimed in the game from the Daily Quest Room, it lands in the **gift chest
of the claiming character's side** (a seasonal character's claim goes to the
seasonal gift chest, a non-seasonal one's to the regular one); used from a
chest onto a character of that side, it is spent.

Nothing uses a backpack by itself. The owner works from the Accounts tab,
one account at a time; the node keeps the facts current and does the daily
login the calendar needs.

## 2. The model

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

### What the node keeps per account (`AccountBackpackState`, `backpack_state.json`)

The played character (id, side, dead, backpack, slots), the character slot
count, the two calendar counters and every backpack day with whether it is
reached (`backpackDays`), the gift chest's backpack count at the last Vault
look (`banked`), the days this month the account logged in (`loginDays`),
the claims made (`claimed`), the last error and when, and the last
per-account job (`lastJob`). `manual` takes an account out of the daily
login; `lastErrorAt` keeps it out for a day after a structural failure.

## 3. What the Accounts tab shows and does

Every card's open half starts with the backpack line
(`BackpackService.viewFor` + `StorageService.backpacksInChests`):

- **Reached day(s)**: two claim buttons, a backpack with the count over its
  corner, one per side. `claim as seasonal` logs in as a seasonal character
  and the backpacks go to the seasonal gift chest; `claim as non-seasonal`
  the same for the regular one. A side the account has no living character
  of is greyed (`canClaimAs`). The played character claims when it is of the
  chosen side, else the lowest-numbered character of that side.
- **Otherwise** the next backpack day ahead and where the counter is, and
  whether the account logged in today; or that the calendar was never read;
  or that nothing is ahead this month.
- **In chests**: backpacks sitting in the gift, vault or spoils chests, per
  side (the side the played character read, and the other side once a
  character of it read them, STORAGE.md).
- **Per character**: `use a backpack` on a character with 8 slots when a
  backpack sits in a chest of its side.
- The last job's outcome, and while a job runs, its activity in the header.

## 4. The two jobs (`startClaim`, `startConsume`)

`POST /backpacks/claim {guid, seasonal?}` and `POST /backpacks/consume
{guid, charId}` on the control plane (`/api/dev/backpacks` actions `claim`
and `consume`). Each returns at once and queues the job on the account, one
at a time (a second one is refused while the first waits or runs). It runs
once the account is free: borrowed from the dispatcher as a storage trip is
(`borrow.ts`: an idle bot at the desk is let go, a login under way
finishes, a login cooldown or a pause is waited out), and while something
else has the account (a trade, another trip), or its login is held back
(logins paused or locked, every proxy host carrying a bot), it is looked at
again every 15 s (`BUSY_RETRY_MS`) for as long as that lasts, the wait a
queued character job gives a busy account. The card shows a waiting job as
queued, with the reason, and a **cancel** that takes it back
(`POST /backpacks/cancel {guid}`, dev action `cancel`); one already running
goes on. The job itself runs for about a minute on a held account.

- **Claim**: one login as the chosen character, `claimBackpackDays`: GOTOQUESTROOM,
  the calendar fetched from inside the room, one CLAIMDAILYLOGINREWARD per
  reached backpack day with its verdict awaited (CLAIMREWARDRESULT), the
  calendar re-read; log out.
- **Use**: one login as the named character (a visit: the played character
  and the roster's side do not change), the Vault, `applyBackpackFromChest`:
  `findBackpack` looks in the gift chest first, then the vault chests, then
  the spoils chest; walk up to it; USEITEM out of the chest; confirmed by the
  HASBACKPACK stat, or INVRESULT ok, or the chest slot emptying, or
  `s.backpack_already_used` (the character had one), with char/list as the
  last resort; log out. The Vault view, its used slot emptied, goes to storage
  (`noteVaultView`) and the character's slots are marked (`noteBackpackApplied`).

## 5. The daily login

The calendar is the same for every account; only the counters are per
account. Its layout is read once per cycle (the monthly reset) by whichever
account reads first and kept by the node (`BackpackStore.noteCalendar`);
every other account whose state is last cycle's takes that layout with its
counters at zero, or one if it already logged in today (`syncCycle`), with
no read of its own. A new account reads once on add for its own counters
(`calendarDue`). From there the node counts for itself: each day's first login moves the two
track counters along (`noteLogin`), a backpack day shows as reached the day
the counter gets to it (`reachedBackpackDays`), and the claim re-reads the
real calendar in the quest room before it claims. Days the read found below
the counter with no key are remembered as claimed.

The calendar advances only on days the account logs in. Every 30 minutes
(`BACKPACK_DAILY_LOGIN_EVERY_S`, first after `BACKPACK_DAILY_LOGIN_FIRST_S`;
`BACKPACK_DAILY_LOGIN=0` turns it off) `dailyLoginPicks` names every account
that has a backpack day still ahead on either track (`pendingBackpackDay`),
has not been in the world today (`loginDays`, which every bring-up records
through `onLogin`), and has no backpack job on it (the job's login counts);
each is brought into the Nexus, its calendar re-read, and logged straight
out, two at a time. An account that is online, busy, held, paused or
login-locked is waited for the way a job is, not skipped; one something
else brought into the world meanwhile needs no login of its own. An account
with nothing ahead is never logged in for this. When a pass leaves a day
reached, the log says so and the card grows its claim buttons.

## 6. Keeping the facts fresh without logins

- The storage refresh's HTTP token (STORAGE.md, `httpRead`) is handed to
  `refreshFromToken` before it is dropped: the character list and the
  calendar are read with it, so a refresh from the Accounts tab brings the
  backpack facts up to date along with the items.
- Every bring-up (`onLogin`) records the login day and, once every 20 hours,
  reads the calendar with the session's token.
- There is no separate calendar run: a new account's first read (the add
  flow's `readAccount`) is that read, so the calendar is known as soon as the
  account is on the roster. The token read also measures whether an
  HTTP-only visit counts as a login day (`observeVerifyLogin`, the old
  notes' §9.1).

## 7. What was removed on 2026-09-22

The demand-driven plan (`planClaims`, stock samples, growth headroom), the
fleet chore (`runChoreTrip` as a run over many accounts, dry and live, the
`BACKPACK_CHORE_LIVE` gate), the dispatcher's backpack orders
(`orderBackpackBot`, `canMakeBackpackBot`; the pool payload's
`room.<half>.canMake` is always false now), the scheduler lanes
(`chorePicks`, `auditPicks`, `backstopPicks`, `loginTargets`), the
disposability rule and the chore's retry accounting. A waiting 16-slot
deposit with no bot that has the room is noted in the log once per side per
ten minutes, for the owner to use a backpack on a character of that side.
