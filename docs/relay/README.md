# Relay (the game side)

`src/relay` is the TypeScript port of the pyrelay fleet: packet codecs and
RC4 (`protocol/`), the socket (`net/`), the Realm HTTP API and build feed
(`realm/`), the game client with world and combat (`client/`), the trade
machine (`trade/`), and the fleet (`fleet/`): roster, tracker, dispatcher,
login gate, backpacks, build gate, telemetry.

On a node the fleet always runs embedded in the site process; there is no
standalone relay. `src/server/main.ts` builds one `Fleet` with a
`LocalSiteApi` (the site's queue, in memory) and mounts the control plane
(`controlPlane.ts`) for the operator console.

Policy: `POLICIES.md`. Backpacks: `BACKPACKS.md`. Account storage (vault
chests, potion rack, gift and spoils chests, character choice): `STORAGE.md`.

## Node-specific parts

- `fleet/buildGate.ts`: holds logins on an unknown Realm build; canary and
  trust (design doc §8).
- `realm/serverList.ts`: server addresses from `account/servers`, cached.
- `fleet/telemetry.ts`: opt-in suspension reports to the hub.
- `fleet/loginGate.ts`: per-account lockouts, the rate-limit breaker, and the
  standing hold the build gate uses.

## Data files (in `RELAY_DATA_DIR`, default `<data>/relay`)

`Accounts.json` (sealed, see `src/node/secrets.ts`), `inventory_state.json`,
`pool_settings.json`, `backpack_state.json`, `gameVersion.txt`,
`servers.json`.

## Fixtures

Packet codecs, RC4 and the potion planner are checked byte-for-byte against
fixtures generated from the Python code (`npm run gen:fixtures` needs the
original pyrelay checkout). They ship in `__tests__/fixtures.json`.
