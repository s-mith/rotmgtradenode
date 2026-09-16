# Relay policy catalogue

Every rule the Python dispatcher enforced, written down so the TypeScript
port in `src/relay/` can be checked against it. Numbers are the defaults;
most are overridable through the environment variable named beside them.

## 1. Connection budget

- **Online cap**: the number of enabled proxy hosts — every exit IP on the
  list can carry a bot. `MAX_ONLINE_BOTS` (0 = off) is an optional ceiling
  on top; `DIRECT_ONLINE_BOTS` (20) is the budget when no pool is loaded.
  Both economies share one budget. In-flight logins count.
- **List refresh**: `PROXIES_URL` is re-downloaded every
  `PROXIES_REFRESH_SECONDS` (900) while running, so hosts added at the
  provider start carrying bots without a restart (and removed ones stop
  being handed out). Pins are recomputed on every change.
- **One bot per exit IP.** A proxy host with a live client (including one
  still authenticating) is never handed to another account. No free host
  means the wake is refused, never a direct connection.
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
  for `RECONNECT_GRACE_SECONDS` (20).
- **Wake retry**: a failed wake is not retried for
  `WAKE_RETRY_COOLDOWN_SECONDS` (15).
- **Bad message received** (FAILURE): disconnect, watchdog re-dials.
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
- **Disconnect rules** for an online, unassigned bot, in order:
  1. sole candidate for a withdraw stranded on another server -> force swap;
  2. still in a protected realm's login queue -> leave it;
  3. on a server with no work while other servers have work -> wait
     `SERVER_SWAP_GRACE_S` (3) of uninterrupted quiet, then swap unless an
     offline bot could cover (then wake that instead);
  4. on a server with work it cannot fulfil, past `WAKE_GRACE_S` (5) -> drop;
  5. no work anywhere, past the wake grace -> drop.
  Exempt from 3-5: residents, standby posts, the login desk, consolidation
  holds, potion collectors.
- **Wake selection** per short server: withdraw candidates first; then the
  emptiest same-pool bot with a free slot (by items held, ties by free
  slots) for deposits; then pull from accountgen if the pool is exhausted.
  Nothing else is woken: a bot that is neither could not claim the work,
  and the old "any same-pool bot" fallback looped (land, fail to fulfil,
  drop, wake another) whenever a withdraw's only candidate was on a login
  cooldown. Bots on a login cooldown are not offline cover either. Skip
  benched servers. Skip entirely under a trade hold.
- **Unjam**: when the cap is full and a server is short, evict surplus idle
  bots in tiers — ordinary idle, collectors, queueing, residents — only as
  many as the shortfall.
- **Register pool size and free slots per pool** (every account on the
  roster, online or not) with the site every pass. The site's fulfill-time
  "is the vault full?" check reads the latter; only the bots online right
  now would call a fleet of thousands full the moment one of them filled.

## 4. Per-bot tick (every `TICK_INTERVAL_S` = 0.5s)

1. Adopt finished logins.
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
   = 90). Collectors yield deposits while another deposit-capable bot is
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
- Partner absent: `give-up` (cancel the row), and disconnect unless on a
  resident or queue-protected realm.
- Other failure: clear the assignment; the site's stale-claim sweep owns it.
- A deposit that leaves the bot at 0 free slots does not refresh wake grace.

## 6. Standing posts

- **Login desk** (communism only): always one in-world bot on a quiet realm
  (`LOGIN_DESK_SERVERS`, avoiding `LOGIN_DESK_AVOID_SERVERS`). Adopt an
  in-world bot if one exists, else wake the emptiest offline account.
- **Standby**: `STANDBY_BOTS` (e.g. `USEast:3s+1n`) empty bots kept in
  world per server and pool; a standby wake is counted for
  `STANDBY_WAKE_GRACE_SECONDS` (30) or while verifiably queueing.
- **Residents**: empty bots on `RESIDENT_EMPTY_SERVERS` stay with no timer,
  at most `RESIDENT_MAX_PER_SERVER` (8) and half the online cap in total.
- **Queue protection**: on `QUEUE_PROTECTED_SERVERS`, a bot reporting a
  queue position is never recycled, up to `QUEUE_PROTECT_MAX_SECONDS`
  (420) from the wake, with `QUEUE_PROTECT_WARMUP_SECONDS` (20) before the
  first queue packet must arrive.

## 7. Potion consolidation (`CONSOLIDATION_ENABLED`, default off)

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
  share of it); bots that are withdraw candidates, standby, or the login desk
  are not planned at all. Moved items keep their instance ids (the tracker
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

Every `ACCOUNTGEN_PULL_COOLDOWN_SECONDS` (10), pull one account from
accountgen: non-seasonal while below `FREE_SLOTS_TARGET` (128) free slots,
otherwise seasonal. The seasonal side is unbounded unless
`SEASONAL_FREE_SLOTS_TARGET` (0 = unbounded) is set: at or above that many
free seasonal slots nothing is pulled, accountgen's ready stock fills to its
`POOL_TARGET` and its mint and walk workers idle until the fleet dips below.

## 9. Maintenance

- **Startup sweep**: log in only bots with no snapshot, no verified stamp,
  or verified within `SWEEP_ONLINE_WINDOW_S` (180) of the state file's last
  write. Up to 25 concurrent, 0.2s apart; settle 4s minimum and 1.5s stable.
- **Ban sweep**: takes a trade hold, drains in-flight trades (180s max),
  then logs in every account (6 concurrent, 1.5s apart), skipping online,
  busy, locked and archived ones; stops after two breaker trips.
- **Trade hold**: no claims, no wakes for player work, no standby fills, no
  new moves. Heartbeats, in-flight trades and the login desk continue.

## 10. Site-facing control plane

`/pool`, `/inventories?since=`, `/settings`, `/whisper`,
`/login/register-code`, `/login/code-state`, `/accounts/*`, `/account?q=`,
`/healthz`. In the unified codebase these become direct calls; the HTTP
shape is kept for the transition.

## 7. Personal storage

A player's vault is a set of physical items (tracker instances) recorded in
the site's `vault_items` table, packed onto bots of their own. An account has
two vaults, one per pool half (a seasonal bot cannot trade a non-seasonal
player), each with its own bot; the account's slot entitlement is split
between them in blocks of 8 from My Vault (`vault_halves`,
`POST /api/vault/allocate`). The site is the source of truth; the fleet
reads it every supervise pass (`listPending().vaultBots`, `listVaults()` —
one entry per half with items) and never guesses.

- **Vault bots** are not pool bots: never woken for pool deposits, never
  cover for pool work, never standby or the login desk, never a giver or
  taker in potion consolidation, and their slots are not pool room. They
  claim only their own account's vault deposits (the site enforces this on
  the claim), pinned by request id, with no deferral.
- **Pinned deposits**: a vault deposit is routed to its bot exactly like a
  single-candidate withdraw — it counts as a target in the work count, the
  bot is woken for the player's server (or force-swapped there if idle
  elsewhere), and nobody else is a candidate. A vault deposit whose account
  has no bot yet is left out of the routing entirely.
- **Received items**: when a vault deposit trade lands, the fulfill waits up
  to `VAULT_ATTACH_MAX_MS` (8s) for the tracker to show the new instances so
  the site can record exactly which physical items the account owns; units
  it cannot match are reported without an instance and logged on the site.
- **Owned items are not stock**: an owned instance sitting on a pool bot (a
  claim waiting to be packed) is subtracted from that bot's inventory for
  withdraw routing, from the claim it offers the site, from the potion
  planner's view, and its slot is never part of an aggregate offer.
- **Packing** (`VAULT_PACK_INTERVAL_SECONDS` = 5, at most
  `VAULT_PACK_MAX_CONCURRENT` = 2 at once): for every owned item the tracker
  sees on a bot other than its owner's, one instance-exact give from that
  bot to the vault bot, driven like a consolidation move (wake both, meet in
  the nexus, the vault bot accepts first), bounded by the vault bot's free
  slots and eight per trade. Items named by an open withdraw are left where
  they are — the withdraw is pinned to their current bot. A finished move
  carries the instance ids across in the tracker and is reported to the
  site (`vaultMoved`).


### Wishlist (standing claims)

A player with the `wishlist` feature (granted per character from the dev
console, Players → Feature access) keeps rules: a pool half (seasonal or
non-seasonal — every wish must say which), an item, a slot requirement
(at least N / exactly N enchantments), and one filter per slot — rows of
chips where a row describes one enchantment (a name, or effect flags like
`+HP` it must carry) and any one row fitting is enough; an empty slot takes
any enchantment. An item fits when its enchantments can be handed to the
slot filters one each, none used twice, so the filters are unordered.
`lib/wishlist.ts` runs every enabled rule over
the relay's `/pool` payload and claims a fit through the same
`claimInstances` path as a manual claim: ledger withdraw row, vault room and
pool-half checks, withdraw rate limit, reservation check. A rule is one
wish: the claim deletes it and logs a `wishlist` vault event, so donating
the item back does not hand it straight to the same wish. Wishes are capped
by the free slots of the vault for their half (items held plus wishes never
exceed that vault), and they hold those slots against reallocation.

Every scan serves wishes oldest first, across all users: each wish in turn
takes one item it fits from the whole pool, whatever the item's age,
preferring the item the fewest other wishes could use so a broad older wish
leaves a contested copy for a narrower newer one. Making a wish runs the
same scan from the create route, so a new wish gets what is already there
unless an older wish fits it too. A full vault or a rate limit skips that
user's wishes for the rest of the scan.

`lib/wishlistScan.ts` drives it: the pool-changed signal (raised by the
embedded fleet on every inventory change, and by claims and donates) is
debounced to one scan per 1.5 s burst, and a 30 s interval backstops a relay
reached over HTTP. No relay fetch happens while no rule is enabled.
