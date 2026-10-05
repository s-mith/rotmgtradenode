# Advanced management

An opt-in way of handling items, switched on separately for **standard
(pool) accounts** and for **communism accounts** (Control panel → Node →
Advanced management). Off by default: with both switches off the node behaves
exactly as before.

It exists for four goals, in this order:

1. A deposit is **one trade with an empty bot** whenever it fits one character.
2. A potion withdraw takes the **fewest trades per potion kind** (16 kinds:
   8 stats × normal/greater).
3. A bulk withdraw is as fast as possible; several bots back to back is fine.
4. Under those, bots spend the **least time online and in the Nexus**.

The reasoning and the simulations behind every rule are in the report
"Item management across every node shape" (2026-10-01).

## Settings (`node.json` → `advanced`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `pool` | off | Standard accounts follow the rules below |
| `communism` | off | Communism accounts follow the rules below |
| `mergeBudget` | `unlimited` | Woken merge pairs in quiet periods: as often as they help, or (`demand`) at most twice the potion withdraws of the last hour. Merges between bots already online together are never limited |
| `lingerS` | 0 | Seconds a bot stays online after its work, idling in its Vault: 0 or 15 |
| `passSurplus` | on | Communism only: when communism accounts run out of room, give surplus to other nodes' communism through the hub |

An account follows the rules when its pool's switch is on
(`advancedFor(settings, acc.communism)`); everything is decided per account,
so a node can run one pool the old way and the other the new way.

## Rules

### Intake: a deposit goes to an empty character

- Only a character holding nothing claims a deposit of an advanced pool. The
  soonest-ready one wins (online and idle, then an online account's other
  empty character, then an offline account with an empty character); ties go
  to the account already holding the most potions, so stock concentrates.
- The whole deposit is one trade when it fits the character; a bigger one
  continues on the next empty character (unavoidable on 8-slot characters).
- A communism deposit is never claimed by a bot with only a few free slots.
- A communism account with characters on both sides of the seasonal split
  serves both: its empty characters on the other side take that side's
  deposits (an account already on the side goes first), a hand-over it
  receives there makes it log in as a character of that side, and the node
  publishes its room on each side to the hub. With communism off here, a
  communism account keeps the side it plays.

### Keep an empty character

- After a deposit, the haul is banked into the vault in idle time, and an
  account never logs out while it has no empty character: it banks first.
- Accounts with several characters keep one character's worth of the vault
  free as a transit reserve and **compact**: the emptiest character's items
  move onto as few other characters as possible (potions to the character
  that already holds their kind). Compaction runs in idle time, or inside a
  session only while the node has slack (under about one request a minute per
  exit IP), at most 6 times an hour per account.
- One-character accounts: when empty bots fall below 10% of the advanced
  pool's roster, the least-full bot hands its items to bots with room
  (**evacuation**), between bots online together or a pair woken in a quiet
  period.

### Potions by kind

- Potions sitting on non-played characters are gathered into the vault, so one
  session reaches an account's whole stack of a kind.
- A stack under 16 of a kind merges into the biggest holder that still has
  room for it, by a bot-to-bot trade: between bots online and idle together,
  or a pair woken in a quiet period (`mergeBudget`).
- Pool and communism stacks are never merged with each other.

### Withdraws

- A potion withdraw picks accounts **best-fit**: the account whose stack of
  the kind just covers the request, else the biggest stacks first.
- One session per account: the holding character, then a vault fetch, then
  other characters of the same account.
- The bot for the next row of a multi-bot withdraw is woken in time for its
  turn rather than after the previous row is fulfilled.
- Communism: a player may ask the hub for "N of this potion"; the node picks
  the copies (fewest bots, on characters before storage).

### Sessions

- The access token is reused for reconnects and character switches within its
  lifetime, and a clean logout is not followed by the 10 s grace (measured
  live 2026-10-01: an immediate reconnect is accepted).
- Idle bots wait in their Vault, not the Nexus, and come back to the Nexus
  when work arrives (about 3 s).

### Surplus (communism)

When communism accounts of a half have no empty character left and no vault
room to bank into, `passSurplus` gives the oldest copies of the most
over-stocked kinds to other nodes' communism through the hub, a bot meeting at
a time, until an empty character is back.

## Not part of it

The login desk, backpacks, sweeps, storage runs started from the console and
player meetings for offers work as before for every account.

## How it is built

- **When no character is empty.** Intake follows the empty-character rule
  only while the side (standard or communism, seasonal or not) has an empty
  character somewhere on the roster that a session could use (not on an
  account locked out for long or suspended, not one an account pinned by an
  open withdraw cannot switch to). With none left, the side takes deposits
  the old way (any bot with room) until banking, compaction, evacuation or
  the surplus rule frees one; and a deposit no empty character has taken
  within `ADV_INTAKE_FALLBACK_SECONDS` puts its side on the old way until it
  is claimed. The dispatcher tells the site per bot in its heartbeat
  (`capacity`, `emptyOnly`); the site's claim checks it.
- **Deposit size.** A side with empty characters offers what they hold
  together, up to one deposit's most (24): a deposit bigger than one
  character continues on the next empty character as a new row of the same
  request (`deposit_requests.continues`).
- **Where things run.** The dispatcher (`relay/fleet/dispatcher.ts`) decides:
  claims, wakes, the idle rules (`superviseAdvanced`), banking and parking in
  the Vault, live fetches, early wakes for a player's next row, merges and
  evacuations (planned by the pure `relay/fleet/advancedPlan.ts`, traded by
  the consolidation machinery with named items), and the offline chores.
  Storage (`relay/fleet/storage.ts`) does the Vault trips on the live client
  and the offline compaction and gathering runs. Logins
  (`relay/fleet/bringUp.ts`, `tokenCache.ts`) keep the access token.
  The site (`lib/queue.ts`, `server/api/withdraw/route.ts`,
  `lib/potionPlan.ts`) gates claims, continues deposits, lists each player's
  next row, and plans potion withdraws best-fit with each account's rows
  back to back. Communism and the hub (`node/`, `rotmgtradehub/`) take
  "N of this potion" requests and pass surplus on.
- **Claims on events.** A new pending row starts a routing pass at once
  (`onPendingChange`) instead of waiting for the next poll.
- **Players first.** Merges, evacuations and chores never take a bot a
  pending request needs, nor move items an open withdraw counts on (its head
  row or the next one); woken pairs and chores run only with no player row
  waiting and free online slots for their logins past `ADV_QUIET_RESERVE`
  (which never takes a node's only slot: a one-IP node gathers and compacts
  in quiet periods and stops when a request comes in), and only while the
  account is inside its login budget.

Tunables (environment, `relay/fleet/constants.ts`):

| Name | Default | Meaning |
| --- | --- | --- |
| `ADV_BANK_BACKOFF_SECONDS` | 600 | After a bank trip left items behind (vault full) or failed, no other one for the account this long |
| `ADV_CHORES_PER_HOUR` | 6 | Compaction and gathering runs per account per hour |
| `ADV_CHORES_INTERVAL_SECONDS` | 20 | How often the chores pass looks |
| `ADV_EVACUATE_BELOW` | 0.1 | One-character accounts: evacuate while fewer than this share stand empty |
| `ADV_MERGE_INTERVAL_SECONDS` | 10 | How often merges and evacuations are planned |
| `ADV_QUIET_RESERVE` | 1 | Online slots kept for players before a woken pair or a chore |
| `ADV_INTAKE_FALLBACK_SECONDS` | 90 | A deposit no empty character has taken in this long: its side takes deposits the old way until it is claimed |
| `ADV_UNUSABLE_LOCKOUT_SECONDS` | 120 | An empty character on an account locked out longer than this is no intake |
| `ADV_BUSY_BACKOFF_SECONDS` | 30 | A live trip refused because something else has the session (a storage run, a character being made): not asked again for this long |
| `ADV_FETCH_BUSY_MAX_SECONDS` | 30 | A live fetch refused as busy this long goes to the storage trip with its own login |
| `ADV_QUIET_PLAN_INTERVAL_SECONDS` | 60 | How often a woken pair is planned (it reads the roster's storage) |
| `ADV_CHORES_SCAN` | 50 | Accounts the chores pass looks at per run, moving on through the roster |
| `ADV_GATHER_CHARS_PER_RUN` | 4 | Characters one gathering run visits at most (it holds the account; a player's request also ends it after the current character) |
| `ADV_BACKGROUND_LOGINS_PER_30MIN` | 12 | Background work (gathering, compaction, woken merges and evacuations) logs an account in only while it has logged in fewer times than this in the last 30 minutes, the run's own logins included; Realm throttles an account that logs in too often. Work for players is never held back |
| `TOKEN_REUSE_MAX_SECONDS` | 600 | Longest an access token is reused (less when Realm states an earlier expiry). Realm's game server refused kept tokens 12-16 minutes old (FAILURE 11 at character load), so a refused one is dropped and a fresh one minted |

The control panel (Node → Advanced management) shows the empty characters
per side and what has been done since the node started.
