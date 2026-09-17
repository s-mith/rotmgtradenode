# Node ↔ hub protocol (v1)

The hub is a private website; nodes are untrusted programs on players'
machines (design doc §3). Everything a node says to the hub is signed with
the node's own key, and the hub never connects to a node.

## Identity

A node generates an Ed25519 keypair on first use of connected mode. The
public key is registered with a hub user account by **linking** (once, with
the account's password); after that the key is the credential. Unlinking on
the website deletes the node row, which revokes the key.

## Signed requests

Every request except `link` and the public feed carries:

    X-Node-Id:   <nodeId, as issued at link time>
    X-Node-Ts:   <unix ms>
    X-Node-Sig:  <base64url ed25519 signature>

over the canonical string

    v1\n<nodeId>\n<ts>\n<METHOD>\n<path with query>\n<sha256(body) hex>

The hub rejects a timestamp more than 5 minutes from its clock, an unknown
node id, or a bad signature. Bodies are JSON.

## Endpoints

| Method | Path | Auth | Body → reply |
| --- | --- | --- | --- |
| GET | `/api/v1/version` | none | → `{ minNodeVersion, latestNodeVersion, downloadUrl, build: { gameVersion, knownBuilds[] , updatedAt } }` |
| POST | `/api/v1/nodes/link` | email+password in body | `{ email, password, publicKey, name, version }` → `{ nodeId, userId, displayName }` |
| POST | `/api/v1/nodes/heartbeat` | signed | `{ version, build, bots: [{ ign, seasonal, online }] }` → `{ ok, serverTime, minNodeVersion }` |
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

Offers, rendezvous and receipts (§6.2), commons (§6.3), shared vaults (§6.5),
Each will be a signed endpoint family under
`/api/v1/`.

## Phase 3: offers, rendezvous, receipts (v1 additions)

All signed. Types are in `src/shared/hubWire.ts` (`OfferWire`,
`RendezvousWire`, `ReceiptWire`, `NodeLimitsWire`).

| Method | Path | Body → reply |
| --- | --- | --- |
| GET | `/api/v1/offers?open=1` | → `{ offers: OfferWire[] , limits: NodeLimitsWire }` every open offer, newest first, `mine` set on the caller's own |
| GET | `/api/v1/offers/mine` | → `{ offers: OfferWire[], limits }` the caller's offers in every state |
| POST | `/api/v1/offers` | `CreateOfferRequest` → `{ offer: OfferWire }` (409 over the node's open-offer limit or frozen) |
| DELETE | `/api/v1/offers/:id` | → `{ ok }` cancels an open offer of the caller's |
| POST | `/api/v1/offers/:id/accept` | `AcceptOfferRequest` → `{ rendezvous: RendezvousWire }` (409 if no longer open, own offer, or limits) |
| GET | `/api/v1/rendezvous/mine` | → `{ rendezvous: RendezvousWire[] }` every rendezvous the caller is part of that is not finished, plus the last 20 finished |
| POST | `/api/v1/rendezvous/:id/receipt` | `ReceiptWire` → `{ ok, state }` |
| POST | `/api/v1/rendezvous/:id/abort` | `{ reason }` → `{ ok, state }` |

Rules the hub enforces:

- The poster's node is the **giver**: its bot sends the trade request and
  offers `give`; the taker's bot offers its `items` and accepts first.
  Both sides verify the other's window against the agreed lists.
- A rendezvous has one `server` (the offer's) and a `deadlineAt` (30 min).
  Past it with no matching receipts it becomes `failed` and the offer
  reopens unless either side reported success.
- **Receipts must match**: both `ok`, and each side's `gave` equals the
  other's `got`. Then `done`; the node's `completedSwaps` grows and each
  side's `partnerIgn` becomes an attestation of the other node's bot. A
  mismatch marks the rendezvous `disputed` and freezes both nodes (no new
  offers or accepts) until the operator clears it.
- **Limits**: `maxOpenOffers = min(8, 1 + floor(completedSwaps / 3))`,
  `maxItemsPerSide = min(24, 4 + 2 * completedSwaps)`. A frozen node's
  offers are hidden.
- Offers expire after 14 days.

## Phase 4b: shared vaults (v1 additions)

Grants (§6.5) live on the hub, keyed by node; the node mirrors them into its
per-user vault tables and does every physical thing. Types are in
`src/shared/hubWire.ts` (`GrantWire`, `PublishVaultsRequest`,
`GuestRequestWire`, `GuestRequestResult`).

Node-signed:

| Method | Path | Body → reply |
| --- | --- | --- |
| GET | `/api/v1/grants` | → `{ grants: GrantWire[] }` this node's grants |
| POST | `/api/v1/grants` | `CreateGrantRequest` → `{ grant }` (404 unknown email, 409 already granted) |
| PUT | `/api/v1/grants/:id` | `UpdateGrantRequest` → `{ grant }` |
| DELETE | `/api/v1/grants/:id` | → `{ ok }` revoke |
| POST | `/api/v1/vaults/publish` | `PublishVaultsRequest` → `{ ok }` replaces the node's published guest vaults |
| GET | `/api/v1/guest-requests` | → `{ requests: GuestRequestWire[] }` pending ones for this node; marks them `taken` |
| POST | `/api/v1/guest-requests/:id/result` | `GuestRequestResult` → `{ ok, state }` |

Offers: `CreateOfferRequest.onBehalfOf` / `AcceptOfferRequest.onBehalfOf`
name a guest of the calling node; the hub checks a grant with `trade` and
not `paused` exists for that node and user, records `offers.for_user_id`,
and shows the guest as `poster`. Limits, attestations and freezes stay per
node.

Website (cookie session, for guests):

- `GET /vaults`: every node the user has a grant on: owner, node name,
  online, slots used/granted per half, role, trade.
- `GET /vaults/:nodeId`: the published vault (both halves) with forms:
  deposit (seasonal, server, count), withdraw (pick refs, server), and, when
  `trade`: create offer (refs + want lines), accept an open offer, cancel
  one of mine. Each form queues a `GuestRequestWire`; the page lists the
  guest's recent requests with state and result.
- The node polls, executes, and posts the result. A request nobody takes
  within 30 minutes becomes `expired`.

Rules the hub enforces: a request needs an unpaused grant; `withdraw` needs
role ≥ withdraw-own (co-owner and withdraw-any may also withdraw the
owner's pool items, which the node checks); `offer-*` needs `trade`;
`deposit` count ≤ the half's free slots as last published.

## Phase 4: commons (v1 additions)

No points, no currency: contributed items are free to take, bounded by a
per-node daily cap the hub operator sets. Items stay on the contributor's
bots; a withdraw is a one-way meeting (the contributor's bot gives, the
withdrawer's bot receives, nothing comes back), and it counts only when both
nodes' receipts agree. Types are in `src/shared/hubWire.ts`
(`CommonsItemWire`, `CommonsListingWire`, `CommonsWithdrawRequest`,
`CommonsStatusWire`; `RendezvousWire.kind` is `"commons"` for these, with
`offerId` null and `commons: { nodeId, ref }` set).

Node-signed:

| Method | Path | Body → reply |
| --- | --- | --- |
| POST | `/api/v1/commons/publish` | `PublishCommonsRequest` → `{ ok, listed }` replaces the node's listing |
| GET | `/api/v1/commons?seasonal=0|1` | → `{ items: CommonsListingWire[], status: CommonsStatusWire }` items of nodes seen within 3 minutes, newest first |
| GET | `/api/v1/commons/mine` | → `{ items: CommonsItemWire[], status }` |
| POST | `/api/v1/commons/withdraw` | `CommonsWithdrawRequest` → `{ rendezvous: RendezvousWire }` (404 not listed, 409 contributor offline / own item / cap reached / node frozen) |

Rules the hub enforces:

- The contributor is the **giver** (invites, offers the item, expects nothing
  back); the withdrawer is the **taker** (accepts first). `me.gives` is
  empty on the taker side; `me.gets` is the item.
- Taking an item unlists it at once; a failed, aborted or expired meeting
  lists it again, and does not count against the cap. `done` counts.
- Receipts match when the giver's `gave` equals the taker's `got` and the
  taker's `gave` is empty. Mismatch → `disputed`, both nodes frozen, as for
  swaps.
- `dailyCap` defaults to 8 and is set on the admin page. A node's own items
  cannot be withdrawn by itself.
- A contributor who moves an item away simply stops listing it on the next
  publish; nothing is owed.

Website: `GET /commons` lists what is available (read-only, needs a
session).
