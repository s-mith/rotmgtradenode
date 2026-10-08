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
operator can still queue moves by hand from the control panel's storage tools (`#storage`, no longer in the nav); reads run from Setup → Accounts.

Source: `src/relay/fleet/storage.ts` (state, planners, trip, service),
`src/relay/fleet/vaultTrip.ts` (getting into the Vault; shared with the
backpack jobs), the dispatcher's fetch orders (`orderFetchesFor` in
`src/relay/fleet/dispatcher.ts`), the pool payload (`stored` in
`src/relay/controlPlane.ts`), the site (`lib/poolWire.ts`, `lib/pool.ts`,
`api/withdraw/route.ts`, `components/Vault.tsx`),
`src/client/pages/dev/settings/StorageTab.tsx`.

## Which pool half a stored item serves

A seasonal character trades only seasonal players, so a stored item is
offered to the halves a character of the account could carry it to:

| where | offered to |
| --- | --- |
| vault chests, potion rack, Gift Chest | the side whose character read them: each is one per side (a seasonal character sees the seasonal vault, rack and gift chest, a non-seasonal one the regular ones) |
| seasonal spoils chest | non-seasonal only (that is what the chest is for) |
| the other side's vault, rack and gift chest (`otherSide`, read by a character of that side during a read) | that side: a fetch for it logs in as a character of that side (`planFetch` names it, the fetch makes it the preferred character), walks into its Vault and takes the items out, and that character then plays the trade, as for items on another character |
| another character's trade slots | that character's side (not storage: the account logs in as that character to trade them) |

Which side each character is on comes from Realm's character list
(`<Seasonal>` per `<Char>`); the account has no side of its own beyond the
character it logs in with. `storedInstances` (pure) applies this. The site's grid reads it through
`inPool`; the withdraw route applies the same gate per item, so a forged id
of the other side is "no longer available" like a tracked one.

## When storage gets read

Reading an account (`Fleet.readAccount`: a new account's first look,
"refresh" on the Accounts tab, a corrected password) is the account
snapshot over HTTP (`StorageService.httpRead`, below): a token from
account/verify and one `char/list` with `muleDump=true`, no game session.
That one call describes the played character (its trade slots go to the
tracker, the same identities a login would give), every other character
with its items' enchantments, the regular side's vault, potion rack, gift
and spoils chests, and the character slots. So every item of an account is
in the pool from its first read, in seconds, without a login.

The HTTP calls go through a proxy host with no bot on it (`httpToken`),
never from this computer's address while a proxy list is loaded: with every
host carrying a bot, a read waits for one to come free (looking every half
second) as long as it waits for the login gate, 90 s, then fails saying
"no free proxy: every proxy host is carrying a bot" (or, with every host
switched off, at once).

Only the seasonal side's vault, rack and gift chest are not in the
snapshot. An account with a seasonal character gets one game login after
the snapshot to walk into the Vault and read them (`visitLoop` with
containers only, `seasonalReader`): as the played character when it is
seasonal (its own chests; skipped when a trip read them in the last five
minutes), else as a seasonal character. A run of queued moves is still a trip into
the Vault as the played character, since moves are INVSWAP packets sent
from inside it; the trip refreshes the regular side's view too, and reads
the snapshot again beside it. The Accounts tab says when an account's
storage was last read, or that it never was.

Container object ids come only from a Vault trip's VAULTINFO; a view built
from the snapshot alone carries `objectId: -1` until the first trip, which
is fine because the trip reads the ids fresh on entry before any move.

## The account snapshot

A read no longer has to log in as every character to learn their items'
enchantments. `char/list` called with `muleDump=true` and without
`do_login` (`realm/api.ts` `getAccountDump`; the call Realm serves account
tools such as the community MuleDump and Exalt Account Manager) answers with
the account snapshot: the ordinary char list, where each `Equipment` token
may carry Realm's id of that copy after a `#`; an `<Account>` block with the
vault (`<Vault><Chest>…</Chest>…`, 8 slots a chest), material storage, the
gift and temporary-gift chests and the potion rack; and `<UniqueItemInfo>`
blocks of `<ItemData type="…" id="…">base64</ItemData>` records, one per
copy that has enchantments — inside each `<Char>` for that character's
items, and at the account level for the containers (`UniqueGiftItemInfo` and
`UniqueTemporaryGiftItemInfo` for the two gift chests). A record is a
little-endian uint16 list from byte 3 (the stat's records share the layout):
enchantment ids up to four, ended by 0xFFFD, with 0xFFFE for a locked slot
and 0xFFFF for an empty one (`protocol/enchants.ts` `decodeSnapshotRecord`).
`parseAccountDump` joins a record to its slot by (type, copy id) when the
token names one, else by type in document order, each record used once —
the join Exalt Account Manager makes; the account-level pool serves the
vault, then material storage, then the potions.

Every read fetches the snapshot with the session's own token right after
the trip (`StorageService.oneLogin`) and files it (`applySnapshot`): every
other living character's trade-slot items with their enchantments, each with
a `charVisits` entry (`source: "snapshot"`) as a visit would leave, and the
enchantments of what the containers hold where the snapshot's slot matches
the vault's (a slot without a record keeps what it had — this node's own
banked items carry their tracker instances). When the snapshot carried
enchantment data (records, or the blocks that would hold them), the
characters are not visited. One HTTPS call instead of one login per
character: the read of an account with 77 stocked characters took 35
minutes and ran into Realm's login attempt limit before the snapshot; now
it is the trip plus a second (verified 2026-09-22: 98 characters, 545
items, 75 enchanted, 417 records in one call). The snapshot needs no
session and claims none.

The call sends no `__source` name (`SNAPSHOT_SOURCE`, empty by default,
would add one) and no game-client headers. Every `<Char>` carries
a small `<Account><Name>` of its own; the account block proper follows the
last character (the parser reads that one — 2026-09-22 it first read the
first and reported no containers). Seen live
2026-09-22: vault with two chests, material
storage, 107 gift items, 7 potions, records for every vault copy that has
a `#id` (one with four enchantments) — and the same with no source name at
all, which is what the node sends. The raw body of each read is kept at
`data/relay/snapshots/<botGuid>.xml`.


### The seasonal side's storage

Realm's snapshot carries the regular side only. Checked live 2026-09-22 on
an account with one character of each side: its `<Account>` had `Vault`,
`MaterialStorage`, `Gifts`, `TemporaryGifts` and `Potions` and nothing
named for the season, and the seasonal character's own Vault (16 rings in
its vault chests, 2 items in its gift chest) was in none of them; the
regular character's gift chest had 158. Exalt Account Manager parses no
seasonal storage from it either. The parser still notes any account-level
tag whose name contains "Season" in `sections`, in case that changes.

So the seasonal vault, potion rack and gift chest are read in the game: a
seasonal character sees them in the Vault the way a non-seasonal one sees
the regular ones. A read logs in as a seasonal character and walks into the
Vault as it (`visitLoop`, `seasonalReader`), whether or not the snapshot
made the item visits unnecessary. When the played character is regular that
is another character, and what it sees is filed under `otherSide` (verified
live 2026-09-22). When the played character is seasonal, the snapshot's
regular chests are the other side's and the played character reads its own
chests: they are the account's `containers`, as a trip's Vault view is
(`applyView`).

The played character can change side: the account's regular characters
are gone and a seasonal one is played, or a season ends and its characters
turn regular. A trip's Vault view follows that (`applyView`), and so does
the snapshot (`applySnapshot`): what the containers held is the other
side's from then on, and what the other side held is the played side's.
Before 2026-10-08 the snapshot did not, and a read never walked into a
seasonal played character's Vault, so such an account's seasonal chests
stayed unread until some trip took it into the Vault.

A vault of hundreds of chests (566 on that account) arrives as VAULTINFO
chunks of 2048 slots; the server sent two and never one flagged last, so
`readVaultInfo` takes the sequence as over `VAULT_INFO_QUIET_MS` after the
last chunk and keeps what came. The chests past 4096 slots are then filled
in from the account snapshot, which lists every chest in the same order
(checked slot for slot on that account) and is read in the same login
(`applySnapshot`, `SnapshotNote.extended`).

## Reading the other characters (the fallback)

char/list's `Equipment` names the item type in every slot of every
character (checked against the live inventory slot for slot, backpack
included, on two accounts 2026-09-19), but nothing more: without the
snapshot, an item's enchantments only come with the game session's stats.
When the snapshot could not be read or carried no enchantment data, a read
ends with a **visit** of each other character that carries something
tradeable (`charsToVisit`: living, not the played one, never visited first,
then the longest ago; `STORAGE_VISIT_MAX_CHARS` caps one read, default
all): the account logs in as that character (`bringUp(..., { charId })`),
stands in world until its inventory settles (`waitForCharacter`), and what
it holds is filed under the character with the enchantments the session
showed (`recordCharVisit`, `source: "session"`), under the identity each
slot already had while its type holds. `charVisits` remembers when, and the
trade slots the session showed; the Storage tab says which characters were
looked at.

A visit is not the account's character of record: `bringUp` with a
`charId` writes no season to the roster and runs no login hook, so the
backpack record and the tracker (which keeps describing the played
character) are untouched, and `loginCharId` does not move. Between logins
the gate's post-session grace (20 s) is waited out. One login per
character: an account with many stocked characters takes minutes to read
and can trip Realm's login attempt limit; the account stays borrowed (held
from the desk) for the whole round, and a withdraw fetch that arrives
meanwhile is told the account is busy and tried again later (one trip per
account at a time).

## Identities

An item with three or four enchantments (legendary, divine) is never listed
in the pool or communism and never picked for a trade: the game will not
trade it (`protocol/enchants.ts` `tradeableEnchants`). It stays where it
is, visible in the Storage tab.

- A container slot gets an instance id the first time it is seen holding a
  tradeable item and keeps it while the slot's type holds
  (`ContainerSnapshot.instances`, formerly `placed`, which named only what
  this node put there; a file from before gets the rest of its identities
  on load, so nothing waits for another trip). An item this node banked
  keeps its tracker instance, enchants included; anything else gets its
  enchantments from the account snapshot ("The account snapshot" above), or
  is listed unenchanted until fetched (VAULTINFO gives types, not enchants). A
  take-out move carries the listed id, so the tracker keeps it on arrival
  (`expectArrival`).
- Another character's items come from char/list's `Equipment` (item type
  per slot; 0-3 equipment, 4 on the trade slots). Every ordinary login reads
  char/list already, so `StorageService.onLogin` refreshes them for free.
  Ids are kept per (character, slot) while the type holds
  (`reconcileCharItems`), and so are the enchantments the snapshot or a
  visit filed; until either, they are listed unenchanted.
- Switching the played character: `onLogin` sees the LOAD id differ from
  `loginCharId` (the character the tracker describes), files the tracker's
  instances under the old character (`charItems`), and promises the new
  character's known instances to the tracker, so nothing changes id and an
  open withdraw pinned to either still names the same items.

## Fetch on withdraw

Picks that all sit on ONE other character of the pinned account are not
fetched at all: the routing marks the row `switchChar` and
`applyCharSwitches` makes that character the account's preferred one
(`BotPool.setPreferredChar`; an idle online account playing the wrong
character logs out), so the next wake logs in as it and the bot trades
straight away. Its trade slots bound the pick (the withdraw route reads
them from `where.capacity`). The identity hand-off is `onLogin`'s: the
other character's known instances are promised to the tracker, so the
pinned ids survive the switch.

The dispatcher's routing (`buildRouting`) marks a withdraw nobody carries
with `fetchFrom` when its pinned bot's containers cover what is missing: a
per-instance row's missing ids, or an aggregate row's shortfall by type
(filled from containers only). `orderFetchesFor` then calls
`StorageService.fetch` once per request:

1. `planFetch` (pure): named items are found in storage; items on one other
   character make that character the one to log in as; items spread over
   two characters, or one other plus the played one, are refused (one trade
   carries one character's items). The withdraw route never sends such a
   row: since 2026-09-29 it splits a pick over several characters of one
   account into a row per character, the played character's first (with
   anything fetched from containers onto it), and the dispatcher serves a
   player's rows one at a time, logging the account in as each character in
   turn (`applyCharSwitches`). A count of a type takes the rack before
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
   merely busy is tried again next pass without counting. As many fetches
   drive accounts at once as the node can have bots online (its proxy
   hosts, or the direct budget); `STORAGE_FETCH_MAX_CONCURRENT` sets a
   number instead.

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
Accounts tab) and the backpack jobs (BACKPACKS.md §4).

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

- Meetings between vaults (offers, communism, shared vaults) still draw
  on the played character's items only; a fetch serves withdraws.
- A fetch is its own login; the bot logs out and is woken again for the
  trade. Staying on for the trade when the withdraw's server suits would
  save a login.
- Materials (the forge's) are read but never moved.
- Not yet verified live: a fetch end to end (the trip itself is the verified
  storage run with take-out moves; the new parts are the planning, the
  character switch bookkeeping and the dispatcher's order).
- Items in the containers carry the enchantments the account snapshot
  gave them ("The account snapshot" above); one the snapshot had no record
  for is listed unenchanted until fetched, when the session shows them.

## Where items live, and what it costs to trade them (2026-09-23)

The layout the node aims for: as many items as possible, every one of them
at most one swap from a trade window. A swap is one INVSWAP on the account;
a login is not counted.

| tier | place | swaps | how it gets in |
| --- | --- | --- | --- |
| 0 | any character's inventory | 0 | deposits land on the played character and stay; a withdraw logs in as whichever character holds the item |
| 1 | a character's equipment slots (`worn`) | 1, in the Nexus | the tuck (below), or the owner |
| 1 | a character's quickslots (`quickslot`, one unit each) | 1, in the Nexus | the tuck; quickslot-allowed consumables only, stacked up to the item's own size (`src/lib/quickslots.json`) |
| 1 | vault chests, potion rack (per side) | 1 plus the Vault walk | banking |
| — | gift and spoils chests | 1 plus the walk | rewards only |

**Worn and quickslot items** are pool items like the rest (`reconcileTucked`
fills `wornItems` / `quickItems` from the character list; the snapshot adds
the worn items' enchantments). A fetch for one names that character
(`planFetch`), and the trip does the swap in the Nexus without walking to the
Vault: `unequip` (equipment slot to the first free trade slot) and `unstack`
(one unit out of a quickslot; slot ids `QUICK_SLOT_FIRST` + n). Both verified
live 2026-09-23 on RottingMeat #204. char/list lags a live swap until the
character saves, so the trip's own outcomes are applied after the snapshot it
reads (`noteTuckedOut`).

**The tuck** (`planTuck`, `StorageService.tuck`, the pass every 30 minutes,
`TUCK=0` off, `TUCK_BELOW_FREE` 4): a played character with fewer free slots
than that puts gear its class can wear into empty equipment slots and
quickslot-allowed consumables into quickslots (`equip`, `stack`), one swap
now to free a zero-swap slot for the next deposit. Nothing a withdraw counts
on is tucked. Also `POST /storage/tuck` for one account (`plan: true` to only
look).

**Character slots** (`createCharacter`; the card's two Wizard buttons, one per
side, are the way to make one; the fill pass is opt-in with `CHARACTER_FILL=1`,
`CHARACTER_FILL_PER_PASS` 2 per account per pass so the login limit is never
met): a new character is a Wizard of the chosen side; a new character on an existing account
needs no tutorial. The client CREATEs instead of loading when asked
(`create.force`), as a visit that changes nothing about the played
character. Also `POST /storage/create-character {guid, seasonal}` and the
card's buttons. Queued new characters wait for a busy account (or held
logins, or every proxy host in use) as long as that lasts, the card saying
why (`characterJobs.createWaiting`); **cancel** takes back the ones still
queued and the one waiting for the account (`{cancel: true}`); one already
on its way (Realm's cooldown, the login) goes on.

**Rotation** (dispatcher `roomierChar` / `rotateFor`): only when the deposit
an account is woken or kept for needs more free trade slots than its played
character has, the account hands itself to the roomiest living character of
the same side that has them (the preferred character changes). A wake for
the deposit logs in as that character; an idle bot on the deposit's server
that cannot take it logs out and comes back as it. An idle account with an
item or two on its character keeps it (it no longer logs out at under 8
free for nothing). Never while open withdraws name the account: they need
the character that holds their items. The items stay listed on the old
character (the storage login hook moves the tracker's instances to
`charItems`), so the deposit lands on fresh slots and nothing is ever moved.
Until it logs in, an account switched to another character is routed with
that character's room.

**The porter** (`planFetch`): a fetch of container items runs as a same-side
character with the room for them when the played one is short of it, so a
vault item is one swap and never a bank-first.

**Deleting a character** (`deleteCharacter`, `POST /storage/delete-character`,
the card's red delete button on every character line): `char/delete` over
HTTP, no game login; the confirm lists what the character carries (inventory,
worn, quickslots) since all of it goes with it. A deleted played character
leaves the account with no preferred one until its next login.

Deletes are queued, and several can wait at once (2026-09-23): the delete
button stays usable while the account is busy or another delete runs, each
queued character says where it is in line (`DELETE QUEUED (2 of 3)`, the one
running `DELETING NOW`), and a queued one can be **taken back** until its turn
(`unqueueDelete`, `POST /storage/unqueue-delete`, dev action `unqueue-delete`;
the one under way cannot). The worker runs the whole queue in one visit
(`deleteQueued`): one borrow of the account and one HTTP token (one
`account/verify`) for all of them, the queue read again after each delete so
what is added meanwhile rides along. A busy or locked-out account, or one
whose calls find every proxy host carrying a bot (each try waits up to 90 s
for one), is looked at again every 15 s (`BUSY_RETRY_MS`, env
`DELETE_RETRY_S`) for as long as that lasts, the card saying why it waits
(`characterJobs.deleteWaiting`); only an account that cannot log in at all
(its credentials, a suspension, Realm's answer) fails what is still queued,
saying why. Queued deletes, drops and new characters are not tied to a
storage run's cancel: each queue has its own way back. Each delete's
outcome is kept (`recentCharacterJobs`, the last twelve; the card lists those
of the last ten minutes). Deletes and drops still queued when the node stops
are picked up again fifteen seconds after it starts (`resumeQueuedJobs`).

## Dropping items (2026-09-23)

Every item tile on an account card is a button. Clicking one opens the drop popup with the item's sprite, name and enchantments and up to three choices: **drop this one**; **drop all N identical** (same item, same enchantments, anywhere on the account: inventory, chests, other characters, worn, quickslot stacks); **drop all M of this item** (same item whatever the enchantments; shown only when M > N). Both "drop all" sets leave the gift chest and the spoils chest alone (user rule 2026-09-23: those chests have no size limit, so emptying them frees nothing); the popup says how many it skipped for that reason. The clicked item itself can still be dropped from either chest with "drop this one". The node queues the instance ids (`POST /storage/drop {guid, instanceIds}`, dev route action `drop`, `StorageService.queueDrop` → `drainDrops`; a character whose trip a busy account turns away keeps its items queued and is tried again every 15 s for as long as that lasts, the card saying `waiting for the account`; **cancel** takes back what is still queued, `{guid, cancel: true}` / `unqueueDrops`); the popup closes at once, the tiles grey out with "drop queued" and the card says `drop queued · N items` until the job ends, then shows `last drop: …` for ten minutes (`characterJobs.dropQueue` / `lastDrop` in the lookup).

How a drop runs (`StorageService.dropItems`): the ids are grouped by the character that reaches them. The played character handles its own inventory, worn and quickslot items and the containers of its side in one `trip`; another character's items go through a `visitTrip` as that character; a container of the other side goes through that side's porter. Per character the moves are: worn → `unequip`, a quickslot unit → `unstack`, a container item → its OUT move, then one `drop` move per item. Drops run last in `runStorageTrip` (after the character moves and the Vault walk): each is one `INVDROP {slotObject, quickSlot: false}` on the inventory slot the item landed in (the trip's `landed` map, else the tracked slot, else any inventory slot holding the type), counted as done when the inventory mirror no longer shows the type there (`swapAckMs`). The run ends with an HTTP snapshot refresh (plus the seasonal-side walk when there is one), which removes the rows. The codec is `INVDROP` in `protocol/packets.ts` (id 19, `SlotObject` + bool; fixtures in `party-fixtures.json`).

Verified live 2026-09-23: Furrygay, one Health Potion in the played character's quickslot (unstack quickslot 1 → inventory slot 8, dropped, ~10 s in world); RottingMeat "drop all 4 identical" Health Potions: #204 unstacked its own, walked into the Vault, took two out of the spoils chest and dropped three, then #206 (seasonal) was visited for its quickslot unit; 4 of 4 dropped, no Health Potion left in the pool, about two minutes including the login cooldowns.
\n
## Communism accounts: what communism does not take (2026-09-23)

An item on a communism account that communism's accepted list does not take (`src/lib/communism-policy.json`, `communismTakes`) is treated as untradable there (`tradeableOn` in `lib/itemPolicy.ts`): it is not in the communism listing the hub gets and a take naming it is refused (`CommunismCoordinator.items` / `giveInstance`); the card greys its tile and counts them ("N items not accepted on communism"). It is also first in line for storage: the tuck pass banks such items into the played side's vault, as far as it has room, before it tucks anything (`planTuck(…, putAway)`), and runs for a communism account that has something to bank whatever its free count; when a fetch must bank items to make room, they go first (`storeFirst`). What the vault cannot take falls through to the ordinary tuck. The same items on a pool account are ordinary stock.
