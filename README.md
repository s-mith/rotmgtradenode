# rotmgtradenode

A self-hosted item pool for Realm of the Mad God (network hub at [rotmg.trade](https://rotmg.trade)). Your own alt accounts hold
your items, on your own computer, through your own proxies. Nothing central to
ban, nothing to shut down.

This is the successor to the RotMG Communism pool. The design lives in
[`design doc`](./design%20doc); this README is how to run it.

## What it does today

- **The pool.** Log in to the site by pasting one `/tell` in game, then deposit
  and withdraw with your own bots: they meet you in the Nexus and trade.
- **Your accounts.** Add an account you made on Realm's site. The node asks
  Realm what it is: bad credentials and suspended accounts are refused, a
  finished account goes on the roster with its character's season and is read
  right away, and one that has never played is refused until you have played
  it through the tutorial. "Refresh" on the Accounts tab re-reads any account,
  and "credentials" corrects a mistyped email or password against Realm.
- **Backpacks.** Claim and equip 16-slot backpacks on the accounts that need
  them (8 + 16 = 24 slots per trade).
- **Every tradeable item.** The catalog is every item the game lets players
  trade: whatever is not Soulbound in the client's `equip.xml` (1061 items on
  build 7.0.0.2.0: all tiered gear, UT/ST, potions, eggs, consumables). Refresh
  it with `npm run sync:equip -- --base <build mirror or extracted client>`.
- **Accepted items.** Each node chooses what its bots take in (Control panel
  → Trading → Accepted items): stat potions, eggs, other consumables, UT/ST
  gear, and a lowest tier per gear group, with per-item pins on top. A deposit
  offering anything else is held, and offers, hand-overs and declared deposits
  are refused up front. What is already in the pool stays withdrawable.
  Communism accounts accept by a fixed list of their own instead
  (`src/lib/communism-policy.json`), unaffected by this setting.
- **The whole account is the pool.** Everything tradeable an account holds
  is on the site and withdrawable: the played character's items, the other
  characters' items, the vault chests, the potion rack, the Gift Chest and
  the seasonal spoils chest. A tile in storage says so; pick it and the bot
  fetches it first (a login as the right character, a walk into the Vault)
  before meeting you. Vault and rack items serve whichever side the account
  has a character for, the spoils chest only non-seasonal characters, the
  Gift Chest the side that read it, another character's items its own side.
  Reading an account also logs in as each other character that carries
  something, one after the other, so their items show their enchantments
  (Realm's character list names item types only). The console (Fleet →
  Storage) still lets you move items by hand and pick which character an
  account logs in with.
- **Proxies.** Paste your proxy list in the console (Fleet → Proxies). Every
  login goes through one of them, one account per exit IP at a time, and by
  default nothing logs in from your own connection.
- **Safety rails.** Logins are held on a Realm build the node has not seen
  work until a single canary login proves the protocol still parses. Server
  addresses are refreshed from Realm.
- **Offers between nodes** (needs the hub). Post what you give for what you
  want; accept someone else's offer with the plainest of your items that fit.
  The hub schedules a meeting on one server, both bots swap in the game's
  trade window, and the hub records the swap only when both nodes' receipts
  agree. The Trading bookmark on the main page.
- **Communism.** Tick "communism" on any of your accounts (Control panel →
  Setup → Accounts) and its slots become a communism like the original RotMG
  Communism pool: everything on it is free for anyone on the hub to take,
  and anyone can deposit into it, as much as they like, by meeting that
  account in game. No points, no caps. Untick the account any time to take
  the storage and whatever is on it back into your pool. The main page's
  Communism bookmark shows your communism and, once linked, every other node's:
  your own bots can take an item from another node's communism onto your
  pool, or hand pool items into one.
- **Local by default.** The server binds to loopback and needs no password;
  it refuses requests from other websites and from host names other than
  this machine's, and it will not start on a non-loopback `HOST` unless
  `DEV_PASSWORD` is set. Account credentials and the hub key are sealed at
  rest, and the node refuses to start rather than make a new sealing key
  over sealed data it cannot open. Proxy credentials are kept in
  `relay/proxies.txt` in plain text, readable only by your user (0600).
  There is no hub account required for any of the above.

The hub ([rotmg.trade](https://rotmg.trade); source in [rotmgtradehub](../rotmgtradehub)) coordinates offers between nodes and communism across nodes: it is a separate
open-source service and is not needed to use this. Once linked, hub users
deposit into and take from this node's communism from the hub website, and
its owner can post and accept offers, take communism items and give them
away with this node from there: those arrive as requests the node runs
within a minute and reports on as they move, and the node reports its
communism, login gate, proxy and account counts with every heartbeat so the
website's node card is live.

## Install

Most people should download the Windows installer
(`rotmgtradenode-Setup-<version>.exe`) and follow
[docs/getting-started.md](docs/getting-started.md). The installer brings
everything the app needs: no Node.js or npm on the PC.

## Run it from source

For development; this needs Node.js 22 or newer and npm.

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
Behind a reverse proxy or under another host name, list the names in
`ALLOWED_HOSTS` (comma separated) and the proxy's address in
`TRUSTED_PROXIES` so its `X-Forwarded-For` counts.

## First accounts

Open the **Control panel** tab at the top of the app, go to
**Setup → Accounts** and add an account:

- made on Realm's site, one per email;
- it must already have a character past the tutorial;
- keep it to a few accounts.

Before anything logs in, paste your proxies under **Control panel → Fleet →
Proxies** (one
per line, `host:port` or `host:port:user:pass`). The "proxy only" rule is on
by default; turn it off only if you really want logins from your own IP.

Then, on the main page, log in with `/tell` and use your pool.

## Rules the node keeps (and why)

The September 2026 ban wave on the shared pool hit the accounts that were
recycled (character deleted and recreated) and the ones logged in by a
scheduled lane. Bots that only traded were barely touched. So this node:

- never deletes or recreates a character on its own (the owner can, by hand,
  from Control panel → Accounts);
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
watching (`%APPDATA%\\rotmgtradenode\\node.log`). A data folder left by the app's
old name, `rotmgtrade`, is moved over the first time the renamed app starts.

Layout: `src/relay` is the game side (protocol, client, trade machine, fleet),
`src/server` + `src/client` the site, `src/node` node-level config, settings,
secrets, and
`electron/` the desktop shell.

## Protocol updates

A Realm patch can change packet ids. When the version feed reports a build
the node does not know, logins are held. Either update (a release that lists
the build in `COMPILED_KNOWN_BUILDS`) or run a canary from **Control panel →
Fleet → Node**:
one account logs in and must hold the world for 30 seconds without a kick.

## License

MIT.
