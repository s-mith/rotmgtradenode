# Account storage: vault chests, potion rack, gift chest, spoils chest

Every account keeps more than its character carries. In the Vault map it has
vault chests (8 slots each), a potion rack, the Gift Chest (what the game
gave it) and the seasonal spoils chest. The node treats all of it as cold
storage per account: the operator queues moves between the character and
these containers from Control panel → Fleet → Storage, and a run carries
them out. Nothing here runs by itself, and items in storage are not in the
pool until they are taken out again.

Source: `src/relay/fleet/storage.ts` (state, planner, trip, service),
`src/relay/fleet/vaultTrip.ts` (getting into the Vault; shared with the
backpack chore), `src/client/pages/dev/settings/StorageTab.tsx`.

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

## Borrowing the desk bot

A one-account node keeps its bot online at the login desk. The service
holds the guid (`maintenanceHolds`, which the desk now respects), asks the
dispatcher to let go (`releaseForMaintenance`: an idle bot is disconnected,
one in a trade is refused), waits out the gate's 20 s post-session cooldown
(up to 90 s; a real lockout is not waited for), then logs in for the trip.
The desk takes the bot back once the trip ends.

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
`placed`: the instances this node put in a slot itself, so they keep their
identity and enchants when they come back — `tracker.expectArrival`), the
character list, the queued moves, the last run.

## Control plane

`GET /storage`, `GET /storage/accounts/:botGuid`, `POST /storage/moves`
(`add`, `remove`, `clear`), `POST /storage/run` (`guids`, `refresh`),
`POST /storage/run/cancel`, `POST /accounts/char` (`guid`, `charId`).
The console reaches them through `/api/dev/storage` and
`/api/dev/accounts {action:"set-char"}`.

## Characters

Switching the login character switches which inventory the node tracks
for that account: the next login snapshots the other character, and the
pool shows its items. Items of the character left behind are not lost —
they come back into the tracker at the next login with it — but their
instance ids are reassigned then, so switch when nothing is queued against
that account.

## Verified live (2026-09-17, node A / Furrygay)

Refresh (5 characters, 2 chests, 7 potions, 108 gifts read), bank of a
tracked and of two untracked items, unbank, potion out of and back into
the rack, a tradeable gift pulled, identity kept across bank/unbank, and a
login as another character followed by the reset. Each move was answered
by its `INVRESULT` within the pace of the player's own client.

## Not done yet

- The dispatcher does not fetch a banked item by itself when a withdraw or
  meeting needs it; the operator takes it out first. That is the natural
  next step (a storage order, like the backpack order).
- Materials (the forge's) are read but never moved.
