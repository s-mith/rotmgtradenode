# Node ↔ hub protocol (v1)

The hub is a private website; nodes are untrusted programs on players'
machines (design doc §3). Everything a node says to the hub is signed with
the node's own key, and the hub never connects to a node.

## Identity

A node generates an Ed25519 keypair on first use of connected mode. The
public key is registered with a hub user account by **linking**, once, with
a **link code** the owner takes from the rotmg trade website (my nodes →
link my node: eight characters, fifteen minutes, one use). Accounts there
are made by signing in with Google or Discord; there are no passwords
anywhere, and the node never asks for one. After linking the key is the
credential. Unlinking (on the website, by the operator, or `POST
/api/v1/nodes/unlink`) revokes the key and winds the node down: its open
offers are cancelled, each meeting under way it had said nothing on is given
up on its side (a partner's offer it had taken opens again), the requests
queued for or naming it fail, its communism leaves the board, and it stops
being the login node. Its row stays (unlinked, keyless), so the meetings it
was in, their receipts and any dispute keep both parties.

## Signed requests

Every request except `link` and the public feed carries:

    X-Node-Id:    <nodeId, as issued at link time>
    X-Node-Ts:    <unix ms>
    X-Node-Nonce: <16..64 of A-Z a-z 0-9 _ -, fresh for every request>
    X-Node-Sig:   <base64url ed25519 signature>

over the canonical string

    v1\n<nodeId>\n<ts>\n<METHOD>\n<path with query>\n<sha256(body) hex>\n<nonce>

The hub rejects a timestamp more than 5 minutes from its clock, an unknown
or unlinked node id, a missing nonce, a bad signature, and a nonce it has
already taken from that node within the clock window (a replay). Bodies are
JSON. A node links over `https://`, or `http://` to a hub on the same
machine only (`HUB_ALLOW_HTTP=1` lifts that on a trusted network).

## Endpoints

| Method | Path | Auth | Body → reply |
| --- | --- | --- | --- |
| GET | `/api/v1/version` | none | → `{ minNodeVersion, latestNodeVersion, downloadUrl, build: { gameVersion, knownBuilds[] , updatedAt } }` |
| POST | `/api/v1/nodes/link` | link code in body | `{ code, publicKey, name, version }` → `{ nodeId, userId, displayName, email }` |
| POST | `/api/v1/nodes/heartbeat` | signed | `{ version, build, bots: [{ ign, seasonal, online }], status? }` → `{ ok, serverTime, minNodeVersion, loginNode }`. `status` (`NodeStatusWire`: the login gate, proxy and account counts, the desk server; `onlineCap` = how many bots it can have online at once (one per enabled proxy) and `maxTradeSlots` = its biggest trade inventory, which set its offer limits (below); `players` = whether it takes trades with players, how many at once, the servers it meets on and its no-show rule (`noShow`); `login` = its login desk bot and whether the node keeps one in game all the time (`alwaysOn`), from the login node only) is what the hub website's node cards show; older nodes omit it. `loginNode` is true for the one node the operator made the login node (Realm logins, below). |
| POST | `/api/v1/nodes/unlink` | signed | `{}` → `{ ok }` |
| POST | `/api/v1/telemetry/bans` | signed | `{ reports: BanReport[] }` → `{ ok, accepted }` |

`BanReport` is `src/relay/fleet/telemetry.ts`'s shape: a salted account
hash, `suspendedAt`, `lastSeenAt`, `lastLane`, `heldItems`, `seasonal`,
`nodeVersion`, `build`.

## What the node does with `/version`

- `minNodeVersion` above its own: the node keeps working locally and marks
  hub features unavailable until updated.
- `build.knownBuilds` containing the feed's current Realm build: the build
  gate records it as known without a canary (design doc §8). The hub only
  lists a build once the operator has confirmed the protocol.

## Later (not in v1)

Offers, rendezvous and receipts (§6.2), communism and hub requests (§6.3,
§6.5). Each is a signed endpoint family under `/api/v1/`.

## Phase 3: offers, rendezvous, receipts (v1 additions)

All signed. Types are in `src/shared/hubWire.ts` (`OfferWire`,
`RendezvousWire`, `ReceiptWire`, `NodeLimitsWire`).

| Method | Path | Body → reply |
| --- | --- | --- |
| GET | `/api/v1/offers?open=1` | → `{ offers: OfferWire[] , limits: NodeLimitsWire }` every open offer of an online node that no meeting holds (below), newest first, `mine` set on the caller's own; `botIgn` only on the caller's own ("" on others': a taker learns the poster's bot from the rendezvous) |
| GET | `/api/v1/offers/mine` | → `{ offers: OfferWire[], limits }` the caller's offers in every state; `heldBy` on an open one a meeting holds, `closedReason` on one the hub withdrew |
| POST | `/api/v1/offers` | `CreateOfferRequest` → `{ offer: OfferWire }` (409 over the node's open-offer limit or frozen) |
| DELETE | `/api/v1/offers/:id` | → `{ ok }` cancels an open offer of the caller's |
| POST | `/api/v1/offers/:id/renew` | → `{ offer: OfferWire }` another 14 days for an open offer of the caller's; an expired one is open again (409 over the open-offer limit) |
| POST | `/api/v1/offers/:id/accept` | `AcceptOfferRequest` → `{ rendezvous: RendezvousWire }` (409 if no longer open, held by a meeting, own offer, one of the taker's items already in a meeting of its node, or limits). An optional `server` moves the meeting off the offer's server when the taker's node cannot trade there (closed or busy) |
| GET | `/api/v1/rendezvous/mine` | → `{ rendezvous: RendezvousWire[] }` every rendezvous the caller is part of that is not finished, plus the last 20 finished. `me.getsItems` lists what arrives per physical item with the enchantments the other node reported |
| POST | `/api/v1/rendezvous/:id/receipt` | `ReceiptWire` → `{ ok, state }`. A node keeps a receipt the hub did not take and sends it again on its next poll; the hub takes one receipt per node and window and ignores repeats. `partnerAbsent: true` on a failure says the partner never came (a player meeting counts it as a no-show) |
| POST | `/api/v1/rendezvous/:id/abort` | `{ reason }` → `{ ok, state }`: gives the caller's side up (409 once the caller has reported) |
| POST | `/api/v1/rendezvous/:id/extend` | `{ reason }` → `{ ok, deadlineAt }`: ten more minutes for a meeting still under way (a bot logging in, a server queue), never past sixteen minutes from its start (409 once it has had all it can) |

Rules the hub enforces:

- The poster's node is the **giver**: its bot sends the trade request and
  offers `give`; the taker's bot offers its `items` and accepts first.
  Both sides verify the other's window against the agreed lists.
- A rendezvous has one `server` (the offer's) and a `deadlineAt` (6 min: a trade takes about a minute once both bots are there).
- **Each side's own word settles its own side** (since 2026-09-28). A trade
  in the game is one action, and each bot checks the other side's window
  before it accepts, so a node's receipt is the truth about its own bot and
  nothing its partner reports can change that. The poster's offer is `done`
  on the poster's own `ok` receipt (at once, whatever the taker has said)
  and `open` again on its failure receipt, its abort, or its silence at the
  deadline. A partner's word never closes, reopens or freezes anything on
  the other side.
- **The meeting as a whole**: `done` once a side reports the trade and the
  other does not contradict it (it agrees, gives up, or says nothing by the
  deadline; a meeting with one `ok` waits for the other side until then);
  `failed` / `aborted` when nobody traded (a failure receipt or an abort
  ends it at once: that bot has stopped, so no trade can happen); `disputed`
  when the two contradict each other: an `ok` and a failure receipt, or two
  `ok` receipts that disagree on what changed hands (each side's `gave` must
  equal the other's `got`; when both carry `gaveItems` / `gotItems` the
  enchantments are compared per item too, a `null` record, unreadable in the
  window, matching by kind). `disputed` is a record for both owners and the
  operator, who sees a count per node; it freezes nobody.
- **Counting**: only two `ok` receipts that agree count the meeting: both
  nodes' `completedSwaps` grow and each side's `partnerIgn` (the name its
  trade window showed) becomes an attestation of the other node's bot. A
  node reporting alone, truthfully or not, moves no count.
- **Late receipts** still settle their own side (a poster's late `ok` closes
  its offer, unless a newer meeting took it meanwhile: both owners hear the
  items are gone and that meeting will fail) and can move the whole
  (`failed` / `aborted` to `done`, `done` to `disputed`); a late agreeing
  receipt counts the meeting then.
- **Abort** gives the caller's side up: for that side like a failure
  receipt, but no claim about the trade (a partner that already reported
  the trade keeps its `done`). Refused once the caller has reported.
- **Meeting time**: `deadlineAt` starts 6 minutes out; a node still trying
  may extend it (above), to 16 minutes from the start at most. The node's bot waits for the other node's bot
  until then and fails its side with a receipt when it never came; the
  hub's own sweep only catches meetings neither side closed.
- **One item in several offers** (since 2026-09-29): a node names each item
  by its instance id (`ITEM_REF_RE`, 32 hex digits) in every offer, accept
  and hand-over, so the same item carries the same ref wherever it is
  promised, and a node may put it in several open offers at once. While a
  meeting under way has the item (an offer of the node taken, an accept, a
  communism give), the node's other open offers naming it are **held**: left
  out of the open list, refused to takers (409), `heldBy` on the owner's own
  list. A new accept or give counting on an item already in a meeting of the
  same node is refused. When a side reports the trade (its `ok` receipt, late
  ones too), its node's other open offers naming what it handed over are
  **withdrawn**: `cancelled` with a `closedReason`, and the owner hears which.
  A meeting that ends without that side trading holds nothing any more, so
  those offers are simply open again. A withdraw from the node's own pool may
  take an item that sits in open offers: the node then deletes those offers
  itself (`DELETE /api/v1/offers/:id`, retried by its minute-long offer check
  while the withdraw is open). Refs of the older form (r1, r2… named
  afresh in each offer) never match across offers.
- **Limits** (since 2026-09-29; `NodeLimitsWire`): every node may have 30
  open offers (`maxOpenOffers`); either side of an offer it posts or takes
  holds up to its biggest trade inventory (`maxItemsPerSide` =
  `status.maxTradeSlots`, 8 until the node reports it, 24 at most: the trade
  window shows both sides the real size, so overstating it only fails the
  node's own trades), and a want line asks for up to that many; a node may
  have as many offers taken at once as it can have bots online
  (`maxTakes` = `status.onlineCap`), and never more of one side than the
  accounts of that side its last heartbeat listed. Accepting, its `botIgn`
  must be one of those accounts and of the offer's side, and a `server`
  (here and everywhere a meeting is placed) one of the game's servers. `completedSwaps` is shown and limits
  nothing any more. Freezing a node is the operator's call alone (the hub's
  admin page): a frozen node posts and accepts nothing, and its offers are
  hidden.
- Offers of a node offline for three minutes are left off the open list and
  refused to takers until it beats again.
- Offers expire after 14 days; `renew` gives another 14.
- `CreateOfferRequest.clientKey` (optional): the node's own key for a post.
  The same key posted again (the first reply was lost) returns the offer the
  first post made. An open offer of a node that the node keeps no record of
  is withdrawn by the node itself.
- A receipt the hub refuses with a 4xx is kept on the node and not sent
  again; one it could not reach is sent on every poll until it lands.

## Phase 4: communism (v1 additions)

No points, no caps: a node sets whole accounts aside for communism, their
slots are its room and everything on them is free to take. The node
publishes accounts and items; the hub shows one board across nodes. Anyone
signed in deposits into or takes from a node's communism by meeting one of its
communism accounts in game (a hub request, below); nodes' own bots take listed
items onto their pool or give pool items into another node's communism in a
one-way meeting that counts only when both receipts agree. Types are in
`src/shared/hubWire.ts` (`CommunismAccountWire`, `CommunismItemWire`,
`PublishCommunismRequest`, `CommunismListingWire`, `CommunismNodeWire`,
`CommunismWithdrawRequest`, `CommunismGiveRequest`, `CommunismStatusWire`;
`RendezvousWire.kind` is `"communism"` for these meetings, with `offerId`
null and `communism: { nodeId, ref }` set for a take, null for a give).

Node-signed:

| Method | Path | Body → reply |
| --- | --- | --- |
| POST | `/api/v1/communism/publish` | `PublishCommunismRequest { accounts, items, at }` → `{ ok, listed, accounts, hash }` replaces both sets for the node (no cap on either; account igns letters 1..32, each account once per side (a communism account under advanced management lists both sides when it has characters on both), free 0..slots). Or a difference: `{ accounts, base, added, removed, at }` where `base` is the `hash` of the last reply (the hub's fingerprint of the node's ref set), `added` the items new or changed, `removed` the refs gone; applied only when `base` matches, else 409 `base mismatch` and the node sends the whole listing. An empty difference is a cheap check-in. An item another node is mid-meeting for is kept even when omitted; listed items keep their `listedAt` |
| GET | `/api/v1/communism?seasonal=0|1` | → `{ items: CommunismListingWire[], nodes: CommunismNodeWire[], status }`: items of online nodes (seen within 3 minutes, not frozen), minus mid-meeting ones, newest first; `nodes` = every linked node with a communism account and its room per half; `status` = the caller's own `{ accounts, slots, free, listed }`. Who runs a node is never said (`contributor` and `owner` are ""), and an item's `botIgn` only on the caller's own items: a taker learns the holding bot from the rendezvous |
| GET | `/api/v1/communism/mine` | → `{ items, accounts, status }` everything the hub holds for the caller |
| POST | `/api/v1/communism/withdraw` | `CommunismWithdrawRequest` → `{ rendezvous }`: node-to-node take (404 not listed / mid-meeting, 409 own item / holder offline or frozen / caller frozen) |
| POST | `/api/v1/communism/give` | `CommunismGiveRequest { nodeId, seasonal, items, server, botIgn, pass? }` → `{ rendezvous }`: node-to-node give; the hub picks the target's communism account with the most room that fits `items` (404 unknown node, 409 own node / target offline or frozen / no room / caller frozen). `pass: true` (advanced management's surplus rule, docs/relay/ADVANCED.md): the node passes communism copies on; `nodeId` may be left out and the hub picks the online node of that half with the most room, trims the give to its room, and names the node in the reply |

Rules the hub enforces:

- A take: communism account is the **giver** (invites, offers the item,
  expects nothing back); the taker's bot accepts first. `me.gives` is empty
  on the taker side; `me.gets` is the item. A give is the same the other way
  round: the giver's bot gives `items`, the chosen communism account takes.
- Taking an item unlists it at once; the holder's own `ok` receipt deletes
  the listing, and a meeting that ends otherwise lists it again. A give
  speaks for the receiving account's room while it is under way: an
  account's room is what its node published less the items of gives still
  under way to it, so a publish meanwhile does not free it, and nothing is
  added back when it ends (the node's next publish says what it holds). A
  give's `done` touches no listing.
- A listed item a person's open withdraw request, or another node's open
  take request, names is off the board and refused to anyone else until
  that request closes (the node carrying out its own take is not refused by
  it).
- A communism meeting the node cannot place yet (the take or give it asked
  for is listed before its own call came back) is given 30 seconds before
  the node gives it up. The node hands over, for a give of its own, only
  the items it asked to give, and for another node's take only an item it
  published.
- Each side's word settles its own side and the whole is judged as for
  swaps. The receipts agree when the giver's `gave` equals the taker's `got`
  and the taker's `gave` is empty; otherwise `disputed`, which freezes
  nobody. Both owners get a `handover` event either way.
- No cap of any kind. A node cannot take its own items or give to itself.

## Player meetings (v1 additions)

Someone who runs no node takes a node's offer with their own character.
The node's owner turns this on (node setting `players`, off by default, with
a cap on meetings at once) and says so in the heartbeat's `status.players`;
older nodes never get one. There is no board of offers on the website: each
offer has a page, `/offers/:id`, whose link its node's owner finds under
"Open offers" on My nodes and shares. There the offer shows **Trade in
game** to a person (and **Take it with my node**, an `offer-accept`
request, to someone with a node of their own; **Cancel** to its poster, an
`offer-cancel` request). The person needs an IGN (a proven one once the hub
has a login node, below).

The hub makes the meeting at once: a rendezvous of kind `player`, the offer
`accepted`, `taker_node_id` null and the person as `taker_user_id`,
`taker_bot_ign` their IGN, on the offer's server or another of
`status.players.servers`, deadline 6 minutes. The node sees it in
`/api/v1/rendezvous/mine` like any other: `me.role` is always `give`,
`me.gives` the offer's items, `me.getsLines` the offer's want lines (what the
person puts up must cover them exactly: which copies is up to them),
`partner = { botIgn: <their IGN>, poster: <their hub name>, player: true }`.

| Method | Path | Body → reply |
| --- | --- | --- |
| POST | `/api/v1/rendezvous/:id/progress` | `MeetingProgressWire { stage, detail, botIgn?, server?, at }` → `{ ok }`: what the meeting page shows the person (`stage`: queued, on-the-way, ready, trading, holding, retry). The first `ready` notifies them (the bot is in the nexus: /trade it). Only the meeting's node; 409 once it is over |

Rules:

- In game the bot waits in the nexus until the deadline, answers the
  person's /trade and invites them itself at most once every two minutes. It
  puts the offer's items up, holds off (saying why, through `progress`) while
  their side does not fit, and accepts only after they did, when it covers
  the want lines exactly, enchantment filters included. A window that closes
  without the trade does not end the meeting: they /trade again, up to six
  windows.
- One witness: the node's receipt alone closes the meeting. `ok` → `done`,
  the offer `done`, the node's `completed_player_trades` up (its
  `completed_swaps`, which drive the offer limits, are not), and the IGN the
  window showed recorded against the person. A failure → `failed`, the offer
  open again; with `partnerAbsent` it counts as a no-show. A success after
  the hub had closed the meeting (deadline, cancel) completes it late: the
  items moved.
- The person may call it off while it runs (`aborted`, the offer reopens, no
  no-show; the node lets its bot go on its next poll), confirm they got their
  items, or report a problem once it is over. A report goes to the operator
  and the node's owner and freezes nobody.
- Caps: one meeting under way per person, six started an hour (the operator
  can lift that for one person on the admin page); the node's no-show rule
  (`status.players.noShow`, set by its owner; two no-shows in a day pause a
  person for a day when absent, a limit of 0 never pauses); a node's
  `maxMeetings` at once (by default one per bot it can have online).

## Realm logins (v1 additions)

The operator can make one node the **login node** (admin page). People then
sign in to the hub, or prove the character they trade with, by whispering a
code to its login desk bot: only a character's own session can /tell as it.
No Realm password ever reaches the hub or the node. The login node learns it
is one from the heartbeat reply (`loginNode: true`) and keeps a long poll open:

| Method | Path | Body → reply |
| --- | --- | --- |
| GET | `/api/v1/realm-logins/pending` | → `{ logins: RealmLoginWire[] }` (`{ id, code, expiresAt }`), each then `taken`; a code taken and not answered with `ready` within 4 minutes is handed out again (the reply may have been lost). `?wait=N` (N ≤ 25) holds the reply until a code is handed out. 403 for any other node |
| POST | `/api/v1/realm-logins/:id/ready` | `RealmLoginReady { botIgn, server? }` → `{ ok, state: "ready" }`: the desk has the code; the website shows `/tell <botIgn> logging into rotmg trade <code>`. `{ error }` instead: no desk bot could take it (the code fails) |
| POST | `/api/v1/realm-logins/:id/verified` | `RealmLoginVerified { ign }` → `{ ok, state: "verified" }`: the character the whisper came from |

The node staffs its login desk on demand unless its owner keeps a bot there
all the time (Control panel → Overview → Login desk): a code it takes is what
brings a bot in, and it answers `ready` once that bot is in the game to hear
the whisper, which can take a minute or two (it gives up after two and a half
and answers `{ error }`). The heartbeat's `login.botIgn` is null while no bot
is there, the normal state of an on-demand desk (`login.alwaysOn: false`).

A code lasts ten minutes and works once. A sign-in lands on the account that
has that character proven, or a new account with no email and the character's
name; proving while signed in makes it the account's IGN and takes it off any
other account that had it proven. With a login node set, communism deposits
and withdraws and trades in game go by proven IGNs only (a typed one no longer
counts). Whoever runs the login node could claim anyone whispered: the
operator names a node they trust (their own), and a whisper never signs in
to an account that signs in another way (an email, Google or Discord, the
operator's included): it can only make or reach Realm-only accounts.

## Hub requests (v1 additions)

The hub keeps one queue of what its users ask a node to do (design doc
§6.5); the node polls, runs and reports. `GuestRequestWire` /
`GuestRequestResult` in `src/shared/hubWire.ts`.

| Method | Path | Body → reply |
| --- | --- | --- |
| GET | `/api/v1/guest-requests` | → `{ requests: GuestRequestWire[] }` every pending request of this node, oldest first; each becomes `taken`. One taken and never answered (no result, not even a progress note) within 2 minutes is handed out again: the reply may have gone to a connection that was gone. The node runs each id once and answers a repeat with the answer it gave. `?wait=N` (N ≤ 25) holds the reply up to N seconds until a request lands: the node keeps one such call open and hears of a request at once |
| POST | `/api/v1/guest-requests/:id/result` | `GuestRequestResult` → `{ ok, state }`. `pending: true` is a progress note: the row stays `taken`, the report replaces its result, any number may follow. Without `pending` the row closes `done` (`ok: true`) or `failed`; a closed row refuses further reports with 409 |

Kinds, and what the hub checks before queuing (the rest is the node's to
refuse):

- `deposit` (anyone): requester has an IGN (users.ign, set on `/me/settings`; a proven one once the hub has a login node),
  node online, `seasonal`, `server`, `count` 1..24 with some communism account
  of that half having `free >= count`. The node queues a communism deposit
  for that IGN and reports the bot to `/trade` once one has claimed it.
- `withdraw` (anyone): IGN, node online, `server`, `refs` 1..8 distinct,
  each listed on that node, not mid-meeting and not named by another open
  withdraw or take, all of one half. While open the request holds them
  (off the board, refused to others). The node queues a
  per-instance communism withdraw pinned to the holding account.
  Or by count ("N of this potion"), only to a node whose heartbeat says
  `advanced.communism`: `refs: null`, `want: [{ itemId, qty }]` (qty 1..8),
  `seasonal`; the hub counts the copies listed in that half that are not
  mid-meeting or held, less what other open by-count requests ask for, and
  refuses when short. The node picks the copies itself (fewest accounts, on
  characters before storage) and answers "only k left" when another request
  got there first.
- `offer-create`, `offer-accept`, `offer-cancel` (owner only): as on the
  board; `refs` are the owner's pool instance ids, not validated by the hub.
  The website queues `offer-accept` and `offer-cancel` from an offer's page;
  `offer-create` (and `communism-give`, below) need the owner's pool, which
  the hub never sees, so they are posted from the node's own control panel
  and stay API-only here.
- `communism-take` (owner only): a listed item of another online node and a
  `server`; the node's bot takes it.
- `communism-give` (owner only): `refs` of the owner's pool, `communism.nodeId`
  another online node with room in that half, `server`.

The node holds every kind to its own server checks, as it does its own
site's trades: a server switched off in its console (deposits for a
`deposit`, withdraws for the rest, as for swaps) or one Realm reports busy
(the load gate, readings up to 90 s old) is refused saying so; a
`communism-take` with no `server` picks an open one at 0% load.

At most 10 open requests per person per node; 30 minutes to be taken, then
`expired` (a node's progress note starts the 30 minutes over). The node
keeps a request's answer until the hub has it, and its final word on a
deposit or withdraw until the hub has that. A withdraw from the website that picks items from several nodes is
one request per node, and the hub hands each to its node only once the one
before has closed (a character has one trade window); its 30 minutes start
then. Deposits and withdraws carry the character the person picked (`ign`),
one of theirs (proven, once the hub has a login node). Website: `/communism` (board, deposit / withdraw / take
forms), `/me` (my requests, refreshing while one is open), `/me/settings`
(the IGN).
