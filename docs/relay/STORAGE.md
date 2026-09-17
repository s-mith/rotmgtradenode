# Account storage: vault chests, potion rack, gift chest, spoils chest, other characters

Every account keeps more than its played character carries. In the Vault
map it has vault chests (8 slots each), a potion rack, the Gift Chest (what
the game gave it) and the seasonal spoils chest; and it may have other
characters, each with trade slots of its own. The node lists all of it in
the pool: every tradeable item in a container or on another character shows
on the site under an identity of its own, tagged with where it is, and can
be withdrawn. A withdraw that names one has the dispatcher order a **fetch**:
the account logs in as the character that can reach the item, walks into
the Vault for whatever sits in a container, and the tracker then holds it
like anything else; the withdraw is routed to the bot on the next pass. The
operator can still queue moves by hand from Control panel → Fleet → Storage.

Source: `src/relay/fleet/storage.ts` (state, planners, trip, service),
`src/relay/fleet/vaultTrip.ts` (getting into the Vault; shared with the
backpack chore), the dispatcher's fetch orders (`orderFetchesFor` in
`src/relay/fleet/dispatcher.ts`), the pool payload (`stored` in
`src/relay/controlPlane.ts`), the site (`lib/poolWire.ts`, `lib/pool.ts`,
`api/withdraw/route.ts`, `components/Vault.tsx`),
`src/client/pages/dev/settings/StorageTab.tsx`.

## Which pool half a stored item serves

A seasonal character trades only seasonal players, so a stored item is
offered to the halves a character of the account could carry it to:

| where | offered to |
| --- | --- |
| vault chests, potion rack | every side the account has a living character of |
| Gift Chest | the side whose character read it (the chest is one per side) |
| seasonal spoils chest | non-seasonal only (that is what the chest is for) |
| another character's trade slots | that character's side |

`storedInstances` (pure) applies this. The site's grid reads it through
`inPool`; the withdraw route applies the same gate per item, so a forged id
of the other side is "no longer available" like a tracked one.

## Identities

- A container slot gets an instance id the first time it is seen holding a
  tradeable item and keeps it while the slot's type holds
  (`ContainerSnapshot.instances`, formerly `placed`, which named only what
  this node put there). An item this node banked keeps its tracker
  instance, enchants included; anything else is listed unenchanted until it
  is fetched (VAULTINFO gives types, not enchants). A take-out move carries
  the listed id, so the tracker keeps it on arrival (`expectArrival`).
- Another character's items come from char/list's `Equipment` (item type
  per slot; 0-3 equipment, 4 on the trade slots). Every ordinary login reads
  char/list already, so `StorageService.onLogin` refreshes them for free.
  Ids are kept per (character, slot) while the type holds
  (`reconcileCharItems`).
- Switching the played character: `onLogin` sees the LOAD id differ from
  `loginCharId` (the character the tracker describes), files the tracker's
  instances under the old character (`charItems`), and promises the new
  character's known instances to the tracker, so nothing changes id and an
  open withdraw pinned to either still names the same items.

## Fetch on withdraw

The dispatcher's routing (`buildRouting`) marks a withdraw nobody carries
with `fetchFrom` when its pinned bot's storage covers what is missing: a
per-instance row's missing ids, or an aggregate row's shortfall by type
(filled from containers only — another character's items are picked item by
item). `orderFetchesFor` then calls `StorageService.fetch` once per request:

1. `planFetch` (pure): named items are found in storage; items on one other
   character make that character the one to log in as; items spread over
   two characters, or one other plus the played one, are refused (one trade
   carries one character's items — the withdraw route refuses such a pick
   up front, with the same words). A count of a type takes the rack before
   the vault before the gift and spoils chests. When the played character
   is of the other side, a living character of the wanted side logs in.
2. The trip (`trip`, shared with the operator's runs): borrow the bot
   (`borrow.ts`), set the preferred character if another must play, log in,
   `runStorageTrip` with the take-out moves. A full character banks what it
   may first (`roomMoves`): its own items, minus what other open withdraws
   name or draw on and minus personal property, as many as the inbound
   moves lack slots for. Snapshot, log out, give back.
3. On success the next routing pass finds the bot a candidate and wakes it
   for the trade as usual. A failed trip is retried after
   `STORAGE_FETCH_RETRY_SECONDS` (60); after `STORAGE_FETCH_MAX_ATTEMPTS`
   (3) trips the request is given up so the player is told. A bot that was
   merely busy is tried again next pass without counting. At most
   `STORAGE_FETCH_MAX_CONCURRENT` (2) fetches drive accounts at once.

The withdraw route bounds a pick to the character's trade slots per bot
(`capacities`, 8/16/24): that is what one trade can carry once fetched.
Aggregate and bulk-potion withdraws count the containers as stock within
the same bound. A stored pick does not bind the request to the bot's current
server (the fetch is a fresh login). The response carries `fetched`, the
number of picks the fleet fetches first, and the form says to allow a few
extra minutes.

## What the game does (captured through rotmgproxy, 2026-09-17)

- From the Nexus, `USEPORTAL` on the Vault Portal (object type 0x0720) →
  `RECONNECT` (gameId -5, name `{"t":"s.vault"}`) → `LOAD` → `CREATESUCCESS`
  → a `VAULTINFO` sequence (packets until `last`). It names five containers by
  object id — `vaultObjectId`, `potionObjectId`, `giftObjectId`,
  `spoilsObjectId`, `materialObjectId` — and lists each one's contents as an
  item type per slot, -1 empty. The vault is one object whose slots run across
  every chest the account owns; the potion rack holds one potion per slot too.
  The lists concatenate across the sequence.
- A move is one `INVSWAP` between the character and a container slot:
  `slotObject1` is where the item is (object id, slot, item type),
  `slotObject2` where it goes (item type -1 for an empty slot). The server
  answers `INVRESULT` (`unknownBool` true = done, `unknownByte` 0 = a swap)
  echoing both slots, within ~120 ms. The player's client walked up to each
  container before swapping with it; the node does the same (within 1 tile).
- Character slots: 0-3 equipment, 4-11 main inventory, 12-27 backpack. The
  plain backpack is 8 slots (12-19, stats 131-138); the upgraded one is 16
  (stats 131-146; a character had slot 25 / stat 144 in use). `char/list`
  gives `BackpackSlots` 0, 8 or 16. `PlayerData.tradeSlots` is 8, 16 or 24 and
  the tracker's capacity follows it; deposits come in 8, 16 or 24.
- The gift and spoils chests are take-only. Only items the pool trades are
  offered from them (`isPoolItem`); the rest is listed greyed out.
- Which character logs in is the `LOAD` id. `Accounts.json` may carry `charId`
  per account (`BotPool.setPreferredChar`); the client uses it when char/list
  still has that character, else the first listed, as the game does. A change
  takes effect at the account's next login.

## Borrowing the desk bot (`borrow.ts`)

A one-account node keeps its bot online at the login desk. The service
holds the guid (`maintenanceHolds`, which the desk now respects), asks the
dispatcher to let go (`releaseForMaintenance`: an idle bot is disconnected,
one in a trade is refused), waits out the gate's 20 s post-session cooldown
(up to 90 s; a real lockout is not waited for), then logs in for the trip.
The desk takes the bot back once the trip ends. The same borrowing serves
`Fleet.readAccount` (a new account's first look, and "read now" on the
Accounts tab).

## The trip (`runStorageTrip`)

1. Wait for the Nexus, read `char/list` (the character list for the tab).
2. `enterVault`: walk to the Vault Portal, `USEPORTAL`, wait for the Vault's
   `MAPINFO` and the `VAULTINFO` sequence.
3. For each queued move, in order: `planMove` resolves the two slots against
   a mirror of the character's inventory and the containers (character →
   container: the tracked instance's slot, checked live, to the container's
   first free slot; container → character: the named slot, checked to still
   hold the item, to the first free trade slot). Walk near the container,
   send the `INVSWAP`, wait for the matching `INVRESULT`, move the mirror
   along. A refused or unanswered swap leaves the move queued with its error.
4. Snapshot the character for the tracker and log out. Items on the
   character that the catalog does not know are recorded as `untracked`
   (they take slots the tracker never counted) and can be banked by slot.

## State (`storage_state.json` in the data dir)

Per account: the last view of each container (object id, slot list, and
`instances`: the identity of every tradeable slot; a file from before, which
named only what this node `placed`, is migrated on load), `viewSeasonal`
(which side's character read the view), the character list with each
character's `equipment`, `loginCharId`, `charItems` (the other characters'
trade-slot instances), the queued moves, the last run. The store has a
revision and a change hook: the pool payload keys on the one and the site
re-serves the pool on the other.

## Control plane

`GET /storage`, `GET /storage/accounts/:botGuid`, `POST /storage/moves`
(`add`, `remove`, `clear`), `POST /storage/run` (`guids`, `refresh`),
`POST /storage/run/cancel`, `POST /accounts/char` (`guid`, `charId`).
The console reaches them through `/api/dev/storage` and
`/api/dev/accounts {action:"set-char"}`.

## Characters

Switching the login character switches which inventory the tracker
describes for that account: the next login snapshots the other character.
The character left behind keeps its items listed in the pool, under the same
ids, as "on <class> (lvl N)"; a withdraw for them has the fleet switch back
(see "Identities" and "Fetch on withdraw" above).

## Verified live (2026-09-17, node A / Furrygay)

Refresh (5 characters, 2 chests, 7 potions, 108 gifts read), bank of a
tracked and of two untracked items, unbank, potion out of and back into
the rack, a tradeable gift pulled, identity kept across bank/unbank, and a
login as another character followed by the reset. Each move was answered
by its `INVRESULT` within the pace of the player's own client.

## Not done yet

- Meetings between vaults (offers, the commons, shared vaults) still draw
  on the played character's items only; a fetch serves withdraws.
- A fetch is its own login; the bot logs out and is woken again for the
  trade. Staying on for the trade when the withdraw's server suits would
  save a login.
- Materials (the forge's) are read but never moved.
- Not yet verified live: a fetch end to end (the trip itself is the verified
  storage run with take-out moves; the new parts are the planning, the
  character switch bookkeeping and the dispatcher's order), and whether
  char/list's `Equipment` lists backpack slots (a shorter list only hides
  those items until that character is played).
