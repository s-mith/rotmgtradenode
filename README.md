# rotmgtrade

A self-hosted vault for Realm of the Mad God. Your own alt accounts hold your
items, on your own computer, through your own proxies. Nothing central to
ban, nothing to shut down.

This is the successor to the RotMG Communism pool. The design lives in
[`design doc`](./design%20doc); this README is how to run it.

## What it does today

- **Vault.** Log in to the site by pasting one `/tell` in game, then deposit
  and withdraw with your own bots: they meet you in the Nexus and trade.
- **Your accounts, walked for you.** Add an account you made on Realm's site;
  if it has never played, the node walks its tutorial and then puts it on the
  roster.
- **Backpacks.** Claim and equip 16-slot backpacks on the accounts that need
  them (8 + 16 = 24 slots per trade).
- **Proxies.** Paste your proxy list in the console (Fleet → Proxies). Every
  login goes through one of them, one account per exit IP at a time, and by
  default nothing logs in from your own connection.
- **Safety rails.** Logins are held on a Realm build the node has not seen
  work until a single canary login proves the protocol still parses. Server
  addresses are refreshed from Realm.
- **Offers between vaults** (needs the hub). Post what you give for what you
  want; accept someone else's offer with the plainest of your items that fit.
  The hub schedules a meeting on one server, both bots swap in the game's
  trade window, and the hub records the swap only when both nodes' receipts
  agree. Control panel → Economy → Offers.
- **Shared vaults** (needs the hub). Give a hub user a personal vault on
  your node: a slot quota per half, a role, and optionally the right to
  trade with those items. They deposit, withdraw and trade from the hub
  website; your bots do the physical trades. Control panel → Players →
  Shared vaults.
- **Local by default.** The server binds to loopback and needs no password.
  Credentials are sealed at rest. There is no hub account required for any of
  the above.

The hub (offers between vaults, the commons, shared vaults) is a separate
open-source service and is not needed to use this.

## Run it

Desktop (Windows first; Linux and macOS builds are best-effort):

```
npm install
npm run desktop
```

Headless, the same server without the window:

```
npm install
npm run build
npm start          # http://127.0.0.1:3000
```

Data lives in `./data` (or `ROTMGTRADE_DATA_DIR`; the desktop app uses its own
user-data folder). Everything is optional env; see `src/node/config.ts`.

## First accounts

Open the **Control panel** tab at the top of the app, go to
**Fleet → Accounts** and add an account:

- made on Realm's site, one per email;
- tick **tutorial done** if it already has a character past the tutorial,
  otherwise the node walks it (watch **Tutorials**);
- keep it to a few accounts.

Before anything logs in, paste your proxies under **Control panel → Fleet →
Proxies** (one
per line, `host:port` or `host:port:user:pass`). The "proxy only" rule is on
by default; turn it off only if you really want logins from your own IP.

Then, on the main page, log in with `/tell` and use your vault.

## Rules the node keeps (and why)

The September 2026 ban wave on the shared pool hit the accounts that were
recycled (character deleted and recreated) and the ones logged in by a
scheduled lane. Bots that only traded were barely touched. So this node:

- never deletes or recreates a character;
- never runs scheduled mass logins; accounts log in when you use them;
- logs in only through your proxies, one account per exit IP, and caps how
  many are online at once;
- refuses to log in on a Realm build it has not seen work.

## Development

```
npm run dev          # Vite + API with reload
npm test             # vitest
npm run typecheck
```

`npm run desktop:pack` builds an unpacked app under `release/`;
`npm run desktop:dist` builds installers. All three desktop scripts go through
`scripts/desktop.mjs`, which rebuilds `better-sqlite3` for Electron's ABI and
puts the Node build back afterwards, because the packaged app runs the server
under Electron's Node. Works on Windows, macOS and Linux; Windows has been
checked by reading, not by running, so the first Windows run is worth
watching (`%APPDATA%\\rotmgtrade\\node.log`).

Layout: `src/relay` is the game side (protocol, client, trade machine, fleet),
`src/server` + `src/client` the site, `src/accountgen` the tutorial walker and
onboarding pool, `src/node` node-level config, settings, secrets, and
`electron/` the desktop shell.

## Protocol updates

A Realm patch can change packet ids. When the version feed reports a build
the node does not know, logins are held. Either update (a release that lists
the build in `COMPILED_KNOWN_BUILDS`) or run a canary from **Control panel →
Fleet → Node**:
one account logs in and must hold the world for 30 seconds without a kick.

## License

MIT.
