# Releasing the desktop app

The desktop app is the node with a tray icon, a window and an updater around
it (`electron/main.mjs`). Owners install it once from the Windows installer;
after that it updates itself from the release feed.

## What CI does (`.github/workflows/node-desktop.yml`)

- **Every push and pull request:** typecheck and `npm test`, on Linux and on
  Windows. The Windows run is there to catch path and file-locking bugs that
  never show on Linux.
- **A tag `v<version>`:** the same tests, then
  - the Windows installer on `windows-latest`: `rotmgtradenode-Setup-<version>.exe`
    and `latest.yml`, signed when the signing secrets exist;
  - the Linux AppImage;
  - both uploaded to a **draft** GitHub release for the tag. Nobody gets an
    update until the draft is published.

The tag must equal `package.json`'s version (`v0.2.0` for `0.2.0`); the run
fails otherwise.

## Cutting a release

1. Bump `version` in `package.json`. After a Realm patch, also add the new
   build to `COMPILED_KNOWN_BUILDS` (`src/relay/fleet/buildGate.ts`) so
   nodes log in on it straight away.
2. Commit, tag `v<version>`, push the tag.
3. When the run is green, download the installer from the draft release (or
   the run's artifacts) and go through the checklist below on a Windows
   machine.
4. Publish the draft. Installed apps download it in the background (they
   check at start and every 6 hours) and install it the next time the owner
   quits from the tray.

Local builds: `npm run desktop:pack` (an unpacked app in `release/`) or
`npm run desktop:dist` (installers). They are unsigned and carry no update
feed unless the variables below are set.

## The update feed

The installed app reads the feed baked in at build time:

| Variables | Feed |
| --- | --- |
| `GH_OWNER`, `GH_REPO` (CI sets them to this repository) | that repository's GitHub releases |
| `UPDATE_URL` | any static server: upload `latest.yml`, the installer and its `.blockmap` there |

GitHub releases must be in a **public** repository: the updater cannot read a
private one without a token, and a token must never ship inside the app. If
the code stays private, publish to a small public "releases" repository
(build with `GH_REPO` set to it) or use `UPDATE_URL`.

## Code signing

Unsigned, Windows shows "Windows protected your PC" (SmartScreen) to everyone
who downloads the installer, and some antivirus products quarantine it. Most
owners will stop there, so sign every public release.

Signing is configured only through environment variables (repository
secrets in CI); nothing secret is in the repository.

### Azure Artifact Signing (recommended, cheapest)

Microsoft renamed Trusted Signing to Artifact Signing. electron-builder still
calls it `azureSignOptions` and signs through the TrustedSigning PowerShell
module, against the same `*.codesigning.azure.net` endpoints.

Who can get a public certificate: organisations in the US, Canada, the EU, the
UK and a few more countries; individual developers only in the US or Canada,
and their Azure billing account must be of type Individual, with the legal
name and address on their government ID.

1. In the Azure portal, register the `Microsoft.CodeSigning` resource provider
   (Subscriptions → your subscription → Resource providers).
2. Create an Artifact Signing account (the Basic tier is enough) and note its
   endpoint, the URL of its region, e.g. `https://eus.codesigning.azure.net`.
3. On the account's Access control (IAM), give yourself the role
   "Artifact Signing Identity Verifier" (an Owner needs it too), then create
   an identity validation (Public; Individual or Organization). It can take
   several days.
4. Once the validation is Completed, create a Public Trust certificate profile.
5. In Microsoft Entra ID → App registrations, register an app for CI, add a
   client secret, and give the app the role "Artifact Signing Certificate
   Profile Signer" on the account.
6. Add these repository secrets:

| Secret | What |
| --- | --- |
| `AZURE_TENANT_ID` | the directory (tenant) id of the app registration |
| `AZURE_CLIENT_ID` | the app registration's client id |
| `AZURE_CLIENT_SECRET` | a client secret of the app registration |
| `AZURE_SIGNING_ENDPOINT` | the account's endpoint, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | the Artifact Signing account name |
| `AZURE_SIGNING_PROFILE` | the certificate profile name |
| `AZURE_SIGNING_PUBLISHER` | the certificate's subject name, exactly as issued |

`AZURE_SIGNING_PUBLISHER` matters: an installed app only accepts updates
signed by that publisher. Changing the signing identity later means listing
both names (`publisherName` in `build/electron-builder.config.cjs`) for a
release or two.

### A classic certificate

An OV or EV code-signing certificate as a `.pfx` works too: put it, base64
encoded, in `WIN_CSC_LINK` and its password in `WIN_CSC_KEY_PASSWORD`. An OV
certificate still meets SmartScreen warnings until downloads build a
reputation. Any signature can meet them for the first downloads; the
reputation builds across releases as long as the publisher stays the same.

With neither set, CI builds an unsigned installer and marks the run with an
"UNSIGNED INSTALLER" warning.

## Windows checklist (a clean machine or VM)

Everything above can be built on Linux, but only Windows can prove these:

- [ ] The installer runs for a normal (non-administrator) user: no admin
      prompt, no SmartScreen warning when signed, Defender does not flag it.
- [ ] Shortcuts appear on the desktop and in the Start menu, and the app opens
      when the installer finishes, on the setup steps.
- [ ] A Windows username with a space or non-English letters, and a Documents
      folder moved to OneDrive, change nothing.
- [ ] Closing the window shows the "still running in the tray" notice once;
      the tray menu's Quit logs the bots out and ends the process.
- [ ] "Start with Windows" survives a restart and starts in the tray only.
- [ ] With "Keep this PC awake" on, the PC does not sleep while the app runs;
      after a manual sleep and wake the bots log back in.
- [ ] Installing the next version over this one keeps the accounts, settings
      and log, and an update published to the feed arrives and installs on quit.
- [ ] Uninstalling from Settings → Apps removes the app and keeps
      `%APPDATA%\rotmgtradenode` (accounts and settings).
