# Deposit API (`/api/ext/*`)

For people running their own depositing bots. One endpoint queues a deposit;
the pool sends a bot with the asked-for room to the named character's realm,
and their bot fills the one trade the same way a human would on the website.

Only deposits are exposed. Withdraws stay behind the in-game login challenge —
see "Why deposits only" below.

## Setup (operator)

Set `EXT_API_KEYS` on the website service — a comma- or whitespace-separated
list of `label:key` pairs:

```
EXT_API_KEYS="alice:sk_a3f1...,bob:sk_9c07..."
```

Generate a key with `openssl rand -hex 24`. Keys must be at least 24
characters; shorter entries are logged and ignored at boot. The label names the
caller in rate-limit buckets and logs — it is not a secret and never has to
match anything in game. Revoke by deleting the entry and redeploying. With
`EXT_API_KEYS` unset, every `/api/ext/*` route answers `503`.

Callers authenticate with either header:

```
Authorization: Bearer <key>
X-Api-Key: <key>
```

## `POST /api/ext/deposit`

Queue a deposit and get back the bot to trade.

```jsonc
{
  "ign": "Someguy",      // required, letters only — the character to credit
  "server": "USEast",    // required, realm that character is sitting in
  "slots": 8,            // optional, 1-16 — the one trade's size (see below)
  "items": [             // optional — what the character is bringing
    { "itemId": "pdef", "qty": 6 },
    { "itemId": "gpdef", "qty": 2 }
  ],
  "seasonal": true,      // optional, default true — which pool half
  "wait": 30             // optional, 0-120s, default 30 — hold open for a bot
}
```

A deposit is **one trade**. `slots` is how big: only a bot with at least that
many free slots comes, so 8 gets an empty bot and 16 gets an empty bot with a
backpack (rarer — the request answers `409` when no bot in the pool has that
much room right now). The trade takes whatever the character puts in the
window, and the request is fulfilled when it closes, however many items
crossed; for more, queue another. Default 8, or 16 when `items` adds up to
more than 8. `itemCount` — the old declared upper bound — is still accepted
and mapped onto `slots` (capped at 16).

`items` is a routing hint: the fleet sends a deposit of defense potions to the
bot that already gathers defense potions, so they never have to be moved
again. It is not enforced — the trade takes whatever the character actually
puts up. Catalog ids, at most 16 entries and 64 items in total.

Answers `202`:

```jsonc
{
  "ok": true,
  "groupId": "4aca1d31-50b1-4545-aa71-48715cc869f2",
  "requestId": 2,
  "ign": "Someguy",
  "server": "USEast",
  "seasonal": true,
  "slots": 8,
  "itemCount": 8,               // the same number, under the old name
  "status": "assigned",         // or "waiting"
  "botIgn": "EmptyBotOne",      // null while "waiting"
  "pollUrl": "/api/ext/deposit/4aca1d31-50b1-4545-aa71-48715cc869f2"
}
```

The request holds open for up to `wait` seconds until a bot is assigned, so the
normal case is a single call that answers "trade `botIgn`". If it comes back
`"waiting"` the queue was busy — poll `pollUrl` until `botIgn` appears. Send
`wait: 0` to skip the hold entirely.

Errors: `400` bad field, `401` missing/invalid key, `409` that IGN already has
a deposit open (`hasOpen: true`), the pool is full, or no bot has `slots` free
right now, `429` over the per-key budget (20 deposits, refilling at 20/min),
`503` no bots online for that pool.

## `GET /api/ext/deposit/<groupId>`

```jsonc
{
  "ok": true,
  "groupId": "4aca1d31-...",
  "ign": "Someguy",
  "groupStatus": "in-flight",   // in-flight | fulfilled | partial | cancelled
  "status": "assigned",         // waiting | assigned | <terminal groupStatus>
  "botIgn": "EmptyBotOne",
  "itemsDeposited": 6,          // items actually received
  "tradeCount": 1,
  "trades": [{ "requestId": 2, "status": "claimed", "botIgn": "EmptyBotOne" }],
  "endReason": null             // "vault-full" when that trade took the pool's last room
}
```

Poll about once a second. `groupStatus` turns `fulfilled` the moment the one
trade closes. An unclaimed request is cancelled automatically after 10
minutes, and a claimed one 5 minutes after the bot last reported in — both
surface here as `groupStatus: "cancelled"`.

## `DELETE /api/ext/deposit/<groupId>`

Give up on a queued deposit and free the bot holding it. Cancels every open
deposit for that IGN (there can only be one). Cancelling during the moment of
hand-off can lose the items in that window — same trade-off as the cancel
button on the website.

## Worked example

```bash
KEY=sk_a3f1...
BASE=https://<site>

resp=$(curl -sS -X POST "$BASE/api/ext/deposit" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"ign":"Someguy","server":"USEast"}')

bot=$(jq -r .botIgn <<<"$resp")
group=$(jq -r .groupId <<<"$resp")

while [ "$bot" = null ]; do
  sleep 1
  s=$(curl -sS "$BASE/api/ext/deposit/$group" -H "Authorization: Bearer $KEY")
  [ "$(jq -r .groupStatus <<<"$s")" = in-flight ] || { echo "gave up: $s"; exit 1; }
  bot=$(jq -r .botIgn <<<"$s")
done

echo "trade $bot on USEast"
```

## Why deposits only

A key authenticates the integration, not a character: unlike the website's
session cookie (minted by an in-game `/tell` challenge), it carries no proof
that the caller controls the IGN it names. That's fine for depositing — the
call only ever moves items *into* the pool, and the caller is the one handing
them over — but it would be a giveaway on the withdraw side. If someone needs
automated withdraws, that needs a different credential, not this one.
