# Relay (TypeScript port of pyrelay)

The bot fleet that fulfils deposits and withdraws in game, rewritten in
TypeScript inside this repo. `src/relay/` is layered bottom-up:

| Layer | What | Verified by |
|---|---|---|
| `protocol/` | RC4, framing, packet codecs, stat ids, enchant records | 49 packet fixtures generated from pyrelay's own packet classes (`npm run gen:fixtures`) |
| `net/` | SOCKS/direct game socket, proxy list parsing | fake Realm server test |
| `realm/` | Realm HTTP auth (verify, token, char list), constants | — (needs real accounts) |
| `client/` | `GameClient`: login, keepalive, movement, failure classification | fake Realm server test |
| `trade/` | trade state machine, partner locks, presence, item map | scripted-packet tests |
| `fleet/` | roster, tracker, proxy pinning, login gate, wakes, sweeps, potion planner, signed site API, **dispatcher** | Python cross-check fixtures + end-to-end test |
| `controlPlane.ts` | the `/pool`, `/inventories`, `/login/*`, `/accounts/*` surface the site calls | — |

Policies are catalogued in `POLICIES.md`; the dispatcher is checked against it.

## Running

Standalone (drop-in for the Python process, same env vars, same data files):

```
DATA_DIR=/path/to/volume COMMUNISM_URL=... COMMUNISM_SECRET=... PYRELAY_AUTH=... npm run relay
```

Embedded in the site process (one lifecycle, no HTTP between them):

```
RELAY_EMBEDDED=1 npm start
```

With `RELAY_EMBEDDED=1` the fleet talks to the site's request queue directly
(`src/lib/queue.ts` via `LocalSiteApi`): no `/api/bot/*` routes, no
signatures, no nonce table. Bot presence lives in memory
(`src/lib/fleetPresence.ts`) and every request transition writes to the
`request_events` table. The pyrelay client short-circuits to the in-process
control plane, so `PYRELAY_URL` and `COMMUNISM_URL`/`COMMUNISM_SECRET` are
not needed; `PYRELAY_AUTH` still is (the control plane checks it).

The standalone relay (`npm run relay`) speaks the HTTP bot protocol
(`COMMUNISM_URL`/`COMMUNISM_SECRET`), which the embedded site no longer
exposes; it is kept for running the fleet apart from the site.

Data files are read from `DATA_DIR` in the same formats pyrelay used:
`Accounts.json`, `inventory_state.json`, `pool_settings.json`,
`unreported_fulfills.jsonl`. The exit-IP list is downloaded from
`PROXIES_URL` (a Webshare list link) at boot and on demand from the dev
console's Proxies tab, and cached to `PROXIES_FILE` (default
`<data dir>/proxies.txt`); with no URL the file is the list. Hosts an
operator switches off persist in `proxy_settings.json`. The game build string for HELLO follows the feed
at `GAME_VERSION_URL` (default `https://rotmg.dia4a.com/global-metadata.txt`,
polled every `GAME_VERSION_POLL_S` seconds, 300 by default; see
`src/relay/realm/gameVersion.ts`). `GAME_VERSION` or `gameVersion.txt` only
seed it until the first fetch; `GAME_VERSION_URL=off` pins them instead.

## accountgen

The account minting/tutorial service is ported too: see `docs/accountgen/README.md`.

## Cutover

See `docs/DEPLOY.md` for the Railway runbook (one service, one volume,
embedded fleet and accountgen).

## Regenerating fixtures

`npm run gen:fixtures` re-runs the Python packet and policy code from
`../rotmgcommunismpyrelay` and rewrites the JSON fixtures the tests compare
against. Do this after any change to the Python side you want to track.
