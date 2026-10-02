# Relay policy catalogue

Every rule the Python dispatcher enforced, written down so the TypeScript
port in `src/relay/` can be checked against it. Numbers are the defaults;
most are overridable through the environment variable named beside them.

## 1. Connection budget

- **Online cap**: the number of enabled proxy hosts — every exit IP on the
  list can carry a bot. `MAX_ONLINE_BOTS` (0 = off) is an optional ceiling
  on top; `DIRECT_ONLINE_BOTS` (1: one account at a time from this
  computer's own IP) is the budget when no pool is loaded.
  Both economies share one budget. In-flight logins count.
- **The list**: the owner pastes it in the console's Proxies tab; it is
  saved to `PROXIES_FILE` (the data dir's `proxies.txt`) and read back at
  boot. Nothing downloads it. Pins are recomputed on every change.
- **One bot per exit IP.** A proxy host with a live client (including one
  still authenticating) is never handed to another account. No free host
  means the wake is refused, never a direct connection.
- **HTTP-only calls wait for a free host.** A storage read, a character
  delete, an account check from the console and the suspended re-check make
  their Realm calls through a host with no bot on it. With a list loaded and
  every host carrying a bot they wait for one, looking every half second,
  for as long as the job would otherwise wait (a read, an account check or
  the re-check: the 90 s a maintenance login waits for the login gate; a
  queued delete: the queue's ten minutes), then fail saying so. They never
  go out from this computer's address; with every host switched off they
  fail at once.
- **Proxy pinning**: each account ranks hosts by rendezvous hash
  (md5(host+guid), descending). It takes the highest-ranked free host within
  `PROXY_PIN_DEPTH` (3); past that, least-recently-used free host, logged at
  most once per `PROXY_PIN_NOTE_INTERVAL_SECONDS` (60) per account.
- **Operator switch**: a host disabled from the dev console (persisted in
  `proxy_settings.json`) is never handed out and doesn't count toward the
  online cap; a bot already on it keeps its session until it disconnects.
- An account's own configured proxy is used only when no pool is loaded.
- **Wake stagger**: `WAKE_STAGGER_SECONDS` (0.25) between any two logins,
  fleet-wide, enforced as a wait on the wake worker (never a refusal).
- **Wakes per tick**: at most `MAX_WAKES_PER_TICK` (10).
- **Raid watchers** (`RAID_WATCHERS=1`, docs/RAIDS.md §5): one bot per
  (server, bazaar side) the site asks for, held out of trading and idling
  rules for the trip, counted against the online cap like any bot. Logins
  paused or no free account → the raid goes unverified. `RAID_BAZAAR_MIRROR=1`
  swaps which Cloth Bazaar Portal is called the left bazaar.
- **Realm hunters** (`REALM_HUNTS=1`, docs/REALMHUNTS.md): one bot per open
  hunt, held out of trading and idling rules for the trip, counted against
  the online cap like any bot. It sits in a realm with a public in-game party
  open and answers "j" in party chat by teleporting, entering the called
  dungeon, counting for 30 s and nexusing back. Logins paused or no free
  account → the hunt ends as "hunter failed" and can be posted again.

## 2. Login gating (per account and channel)

- **Attempt limit**: Realm's "LOGIN ATTEMPT LIMIT" locks the account for
  the minutes it names (default 5). Recorded as an account lockout.
- **Breaker**: `LOGIN_LIMIT_TRIP_COUNT` (3) attempt-limit refusals inside
  `LOGIN_LIMIT_TRIP_WINDOW_SECONDS` (60) pause ALL logins for
  `LOGIN_PAUSE_SECONDS` (300). A successful login clears the tally.
- **Account in use** (char/list or FAILURE text): lockout for the stated
  seconds + 3, clamped to 120, default 15 when unstated. Never trips the
  breaker.
- **Token security error** (FAILURE id 20, empty description): drop the
  access token, stop the client, lockout 20s. Waiting does not fix it.
- **Rate limit** (FAILURE id 0 or "try again"/"wait"): lockout
  max(stated, 60). If the text says "connection amount", bench the SERVER
  for 45s as well.
- **IP ban** ("temporarily banned"/"abuse"): stop the client only. The host
  stays in rotation; the next wake re-picks.
- **Suspended** (any auth step says SUSPENDED): retire the account
  (`suspended: true` persisted in Accounts.json, year-long lockout).
- **Reconnect grace**: after WE disconnect a bot, its account is locked out
  for `RECONNECT_GRACE_SECONDS` (10).
- **Wake retry**: a failed wake is not retried for
  `WAKE_RETRY_COOLDOWN_SECONDS` (15).
- **Bad message received** (FAILURE): disconnect, watchdog re-dials.
- **Re-dial backoff**: the watchdog re-dials a lost session after 2.5 s of
  silence, then waits twice as long before each further try (5 s, 10 s, 20 s
  and so on, at most 60 s) until a session reaches the world again, so a
  server that is down is not hammered.
- **HTTP checks respect the gate**: account probes (adding an account,
  correcting credentials) and Retry suspended ask Realm nothing while
  logins are paused after its attempt limit or while the account waits out
  a cooldown of its own (a suspension alone does not stop a re-check), and
  an attempt limit they meet counts at the gate like a login's.
  `s.update_client` / bad credentials: stop.

## 3. Supervisor (every `SUPERVISE_INTERVAL_S` = 2s)

Input: the site's pending rows (`list-pending`), routed locally against the
inventory tracker.

- **Routing**: a withdraw's candidates are bots of the player's pool whose
  tracked inventory covers it; per-instance rows only the pinned bot while
  it still holds every instance; aggregate pinned rows only the pinned bot.
  Deposits need any same-pool bot with a free slot. Suspended bots are
  never candidates.
- **Distinct work count** per server: one per uniquely-pinned withdraw plus
  one per other row; at least 1 when anything is pending.
- **Login queue**: a bot that finds itself in a server's login queue (a
  queue packet since its last connect, on any server) disconnects on the
  next tick. The deposit or withdraw it had claimed is cancelled with the
  reason "<server> had a login queue", and so are the rows its wake was for
  that no bot already in world there can take; a cross-node swap or player
  meeting row is only handed back (it lives by the hub's deadline). The
  server is benched `LOGIN_QUEUE_BENCH_S` (45, the bench a FAILURE saying
  the queue is full gets) so the next wake, the login desk's above all,
  does not walk into the same queue.
- **Rows no account can serve**: every pass, before any wake, a pending
  deposit that no account of its side (pool or communism, suspended ones
  aside) has the room for — on the character it plays or on a living
  character of the same side it would rotate to — is cancelled with the
  reason ("no seasonal account has room for a 16-slot trade", "every
  non-seasonal account that could take it is suspended"). A pending
  withdraw with no candidate, no fetch and no character switch is cancelled
  when what it asks for is nowhere on the node: a pick whose account left
  the roster or is suspended, or whose item is on no account any more; a
  withdraw by type when no account of its side that can trade holds that
  many, on a character or in storage it can reach. Never a swap or meeting
  row. A row waiting for a login, a cooldown, a proxy, a fetch or a busy
  bot is left alone. A pending withdraw still ages out after 10 minutes
  (`lib/timeouts.ts`); a pending deposit has no clock.
- **Disconnect rules** for an online, unassigned bot, in order:
  1. sole candidate for a withdraw stranded on another server -> force swap;
  2. on a server with no work while other servers have work -> wait
     `SERVER_SWAP_GRACE_S` (3) of uninterrupted quiet, then swap unless an
     offline bot could cover (then wake that instead);
  3. on a server with work it cannot fulfil, past `WAKE_GRACE_S` (5) -> drop
     (when a deposit there needs more room than its character has and a
     roomier character of its side has it, it comes back as that one);
  4. no work anywhere, past the wake grace -> drop.
  Exempt from 2-4: the login desk, consolidation holds, potion collectors.
- **Wake selection** per short server: withdraw candidates first; then the
  emptiest same-pool bot with a free slot (by items held, ties by free
  slots) for deposits. A bot whose character is short of the room the
  deposit needs counts with a roomier living character of its side, and
  logs in as that one (character rotation, STORAGE.md).
  Nothing else is woken: a bot that is neither could not claim the work,
  and the old "any same-pool bot" fallback looped (land, fail to fulfil,
  drop, wake another) whenever a withdraw's only candidate was on a login
  cooldown. Bots on a login cooldown are not offline cover either. Skip
  benched servers. Skip entirely under a trade hold.
- **Unjam**: when the cap is full and a server is short, evict surplus idle
  bots in tiers — ordinary idle, then collectors — only as many as the
  shortfall.
- **Register pool size and free slots per pool** (every account on the
  roster, online or not; communism accounts summed apart) with the site every
  pass. The site's fulfill-time "is the pool full?" check reads the latter;
  only the bots online right now would call a fleet of thousands full the
  moment one of them filled.

## 4. Per-bot tick (every `TICK_INTERVAL_S` = 0.5s)

1. Adopt finished logins. A bot in a server's login queue leaves it (§3).
2. Refresh the tracker from live inventory once the bot is in world, named,
   and has seen the ENCHANTMENTS stat. Slots 4..11, plus 12..19 only when
   the pool-wide backpack setting is on. Capacity is pool-wide (8 or 16).
3. Report a finished trade before the heartbeat.
4. Heartbeat every `HEARTBEAT_INTERVAL_S` (5) or immediately on status
   change. Status: `busy` when assigned, `offline` until in world and named,
   else `idle`. Carries free slots, IGN, server, seasonal.
5. If assigned and the trade machine is idle: re-send the request when in
   nexus; otherwise give the row back after `PARTNER_WAIT_MAX_SECONDS`
   (240). Consolidation assignments are dropped after
   `CONSOLIDATION_ASSIGNMENT_MAX_SECONDS` (200) with nothing in flight.
6. Otherwise claim every `CLAIM_INTERVAL_S` (1.5) — withdraw first, then
   deposit — but only when the routing view (fresh within
   `ROUTING_FRESH_SECONDS` = 8) shows something this bot could take.
   Claims are skipped under a trade hold, before in-world, and for bots
   held for a potion move.
7. **Deposit steering**: yield a deposit when an emptier bot is online on
   the same server (bounded by `DEPOSIT_DEFER_MAX_SECONDS` = 20) or when an
   empty account is being woken for it (`DEPOSIT_EMPTY_WAKE_WAIT_SECONDS`
   = 20). Collectors yield deposits while another deposit-capable bot is
   on the server, and to the supervisor a collector only covers a deposit
   routed to it — for any other deposit it yields like every bot carrying
   items, so an empty bot gets woken while it waits.
8. On a claim: mark busy, hand the assignment to the trade machine, go to
   nexus if not there, else send the request now.

## 5. Outcomes

- Success: report `fulfill` / `withdraw-fulfill` with retries
  (`FULFILL_RETRY_MAX_ATTEMPTS` = 8, linear backoff
  `FULFILL_RETRY_BACKOFF_SECONDS` = 5). Terminal server errors stop retries.
  Exhausted retries go to `unreported_fulfills.jsonl`.
- Partner absent: `give-up` (cancel the row), and disconnect.
- Other failure: clear the assignment; the site's stale-claim sweep owns it.
- A deposit that leaves the bot at 0 free slots does not refresh wake grace.

## 6. Standing posts

- **Login desk** (communism only): always one in-world bot on an empty
  server: any server Realm's fresh load reading (account/servers, under
  90 s old) reports empty, the configured `LOGIN_DESK_SERVERS` first, then
  the account's own server, then any other; without a fresh reading, or
  with no empty server, the configured ones. Never a jammed server or one in
  `LOGIN_DESK_AVOID_SERVERS` (empty by default). Adopt an in-world bot if
  one exists, else wake the emptiest offline account. A bot woken within `LOGIN_DESK_WARMUP_SECONDS` (20) and
  not in world yet is about to staff it: no second one is woken meanwhile.

No other post keeps a bot online: a bot with nothing to do logs out by the
rules of §3.

## 7. Potion consolidation (`CONSOLIDATION_ENABLED`, default off)

Advanced management (`ADVANCED.md`, a node setting per pool) replaces this
planner for the pools it is on: its accounts are left out of the planner
below, and their potions are merged by kind instead (`fleet/advancedPlan.ts`).

Pure planner over the tracker (see `fleet/potionConsolidation.ts`). The site
splits a withdraw across bots and pins each fragment to one, so what a player
pays for is trades; the planner's job is to keep each *bucket* on as few bots
as capacity allows — which is the same as keeping the most bots empty. A
bucket is a stat (or one potion type once the pool holds a bot's worth of
both its normal and greater kind — `CONSOLIDATION_SPLIT_GREATERS` =
auto|always|never), and everything that isn't a potion is one more bucket,
`misc`, gathered the same way.

- **Roles** are elected by majority and sticky: a bot keeps its bucket until
  another outgrows it by more than `CONSOLIDATION_ROLE_HYSTERESIS` (2).
- **Collectors** per bucket: the biggest holders, as many as it takes for
  their room to hold the pool's whole bucket (role breaks ties; empty bots
  fill in, one bucket each). Potions only ever flow uphill — onto a
  collector, and from a lesser collector to a bigger one with room — so a
  stack is never split to seed a smaller one.
- **Candidates** are scored every `CONSOLIDATION_INTERVAL_SECONDS` (5) and
  the best non-overlapping ones taken, at most `CONSOLIDATION_MAX_PAIRS` (3)
  in flight, alternating pools. Score = potions
  moved + 4 if the giver ends empty (+ up to 2 the closer to empty it gets) +
  2 if it ends with none of the bucket +
  2 if the collector fills (+0.05 per potion already on it, to fill the
  fullest first), minus `CONSOLIDATION_WAKE_COST` (2) per offline bot and
  `CONSOLIDATION_HOP_COST` (3) when both are online on different servers.
  Anything under `CONSOLIDATION_MIN_SCORE` (2) is not worth a trade.
  Kinds, in priority: *demand* (a pending withdraw with no candidate bot —
  top up the bot it is pinned to, or whoever covers most of it; +20),
  *swap* (`CONSOLIDATION_SWAPS`, default on: two bots of different roles each
  holding the other's bucket trade both ways in one window, so full bots can
  still untangle), *give*. A stack nobody else holds is left where it is:
  carting it elsewhere costs a trade and frees nothing.
- **Never moved**: items a pending withdraw counts on (any candidate bot's
  share of it); bots that are withdraw candidates or the login desk are not
  planned at all. Moved items keep their instance ids (the tracker
  carries them over to the receiving bot), so a per-instance withdraw picked
  before the move still names the same item on its new bot.
- **Setup**: a move holds both bots, wakes them if allowed
  (`CONSOLIDATION_WAKE_RESERVE` = 4 slots kept for players), brings an idle
  bot over from another server once, waits `CONSOLIDATION_PAIR_SETTLE_SECONDS`
  (5) with both in nexus, re-checks live room on each receiving side and that
  the items are still there, assigns the taker first, and is abandoned after
  `CONSOLIDATION_SETUP_TIMEOUT_SECONDS` (180) with both bots benched for
  `CONSOLIDATION_RETRY_BACKOFF_SECONDS` (60).
- **Deposit hints**: a deposit that declares its items (`items` on
  `/api/deposit` and `/api/ext/deposit`) is routed to its main bucket's home
  (a collector, else the biggest holder with room): that bot claims it by id,
  other bots on the server wait `DEPOSIT_COLLECTOR_WAIT_SECONDS` (20) for it,
  and it is the first choice to wake for that deposit.
- **Measure**: each pass computes a spread score per pool (1 = every bucket
  on as few bots as capacity allows), how many bots are empty against how
  many could be, and the trades a 16-point withdraw of each stat would take;
  logged when the score moves by 0.02 or every
  `CONSOLIDATION_METRICS_LOG_SECONDS` (300), and served with the pending and
  last-planned moves at `GET /consolidation` on the control plane.
  `npx tsx scripts/sim-consolidation.ts` replays a random deposit/withdraw
  stream against the legacy and current planners.

Collectors are held online up to `COLLECTOR_HOLD_MAX_SECONDS` (600).
Capacity for planning: an online bot's live per-bot detection; an offline
bot counts as 8 until a login proves a backpack (the state inherited from
the Python fleet has stale 16s).

## 8. Capacity growth

The roster is the owner's own accounts; nothing is pulled from anywhere to grow it.

## 9. Maintenance

- **Startup sweep**: log in only bots with no snapshot, no verified stamp,
  or verified within `SWEEP_ONLINE_WINDOW_S` (180) of the state file's last
  write. Up to 25 concurrent, 0.2s apart; settle 4s minimum and 1.5s stable.
- **Ban sweep**: takes a trade hold, drains in-flight trades (180s max),
  then logs in every account (6 concurrent, 1.5s apart), skipping online,
  busy, locked and archived ones; stops after two breaker trips.
- **Trade hold**: no claims, no wakes for player work, no new moves. Heartbeats, in-flight trades and the login desk continue.

## 10. Site-facing control plane

`/pool`, `/inventories?since=`, `/settings`, `/whisper`,
`/login/register-code`, `/login/code-state`, `/accounts/*`, `/account?q=`,
`/healthz`. In the unified codebase these become direct calls; the HTTP
shape is kept for the transition.

## 11. Communism (node)

An account the operator ticks "communism" on (Control panel → Accounts,
`BotPool.setCommunism`) is a communism account: its trade slots are communism's
room and everything on it, character slots and storage alike, is a communism
item (`lib/communismPool.ts`). The pool is everything on the other accounts.
The fleet treats communism accounts the way it once treated vault bots: never
woken for pool work, never a collector, never in consolidation or the login
desk, never counted as pool capacity (`freeSlotsByPool().communism` reports
their room separately). A communism deposit (`deposit_requests.communism = 1`)
is claimable only by a communism account of its half, with whatever room it
has; the dispatcher wakes the roomiest one. A communism withdraw is a
per-instance row pinned to the holding account (`withdraw_requests.communism =
1`); a pool withdraw by type never comes off a communism account. Unticking
the account makes it a pool account again with whatever it holds. Requests
come from the node's own page (the Communism bookmark) and from hub users
through `src/node/requests.ts`.

Staying current and staying ready: the coordinator publishes to the hub
within `COMMUNISM_PUBLISH_DEBOUNCE_MS` (1.5 s) of any change on a communism
account, as the difference since the hub's last reply (`base` + `added` +
`removed`, a few hundred bytes per trade) rather than the whole listing; a
tick every `COMMUNISM_PUBLISH_SECONDS` (10) catches an account logging in or
out and sends nothing when nothing changed; every 10 minutes an empty
difference checks the hub still holds the listing. Hub requests are pulled
with a long poll (`GUEST_WAIT_SECONDS`, 25): the hub answers the moment one
is queued. A communism account follows the ordinary idle disconnect like
every bot (it no longer lingers online): the next request logs it in again.
Progress on a hub request is reported when the queue moves, not on a timer.

## Accepted items (node)

The catalog (`src/lib/catalog.ts`) is every item the game lets players
trade. A node's `items` setting (`src/lib/itemPolicy.ts`, Control panel →
Trading → Accepted items) narrows what its bots take in: switches for stat
potions, eggs, other consumables and UT/ST gear, a lowest tier per gear
group, and per-item pins that beat the rules. The trade machine holds a
deposit that offers a refused item (`TradeSessionOptions.acceptsType`);
declared deposits, offer wants and accepting an offer are refused up front.
Items already in the pool are unaffected.

Communism accounts do not follow this setting. They accept by a list fixed
in the code (`src/lib/communism-policy.json`, `COMMUNISM_ITEM_POLICY`,
`communismTakes`): every category, minus the items the owner had pinned off
on their node on 2026-09-22. It applies in game (`acceptsType` for a
communism account), to declared communism deposits and to taking another
node's item into communism; the Accepted items tab never touches it.
\n
### On a communism account, what the list does not take

An item already on a communism account that the fixed list does not take is treated as untradable there: never listed for communism, never given, greyed on the account card, and put into the vault first by the storage chore (docs/relay/STORAGE.md, "Communism accounts: what communism does not take"). Flagging an account for communism does not throw anything away.
