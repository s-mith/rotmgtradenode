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
