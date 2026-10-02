// electron-builder configuration: the Windows installer, the Linux AppImage,
// the update feed and code signing. scripts/desktop.mjs and the CI workflow
// pass it with `--config build/electron-builder.config.cjs`. Everything secret
// or account-specific comes from the environment, never from this file; what
// is not set is left out, so a local build is an unsigned one with no update
// feed (docs/release.md).
const env = process.env;
const set = (name) => typeof env[name] === "string" && env[name].trim() !== "";

/**
 * Azure Artifact Signing (formerly Trusted Signing). The endpoint, the signing account and the
 * certificate profile name the certificate; the Azure login itself
 * (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) is read from the
 * environment by Microsoft's signing module. AZURE_SIGNING_PUBLISHER must be
 * the certificate's subject name exactly: installed apps only take updates
 * signed by that publisher.
 */
const azureSignOptions =
  set("AZURE_SIGNING_ENDPOINT") && set("AZURE_SIGNING_ACCOUNT") && set("AZURE_SIGNING_PROFILE")
    ? {
        publisherName: env.AZURE_SIGNING_PUBLISHER || "rotmgtradenode",
        endpoint: env.AZURE_SIGNING_ENDPOINT,
        codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
        certificateProfileName: env.AZURE_SIGNING_PROFILE,
      }
    : null;

/**
 * Where installed apps look for updates: the GitHub releases of GH_OWNER/GH_REPO
 * (they must be public), or any static server at UPDATE_URL. CI publishes a
 * draft release; nobody updates until it is published.
 */
const publish = set("GH_OWNER") && set("GH_REPO")
  ? { provider: "github", owner: env.GH_OWNER, repo: env.GH_REPO, releaseType: "draft" }
  : set("UPDATE_URL")
    ? { provider: "generic", url: env.UPDATE_URL }
    : null;

module.exports = {
  appId: "trade.rotmg.rotmgtradenode",
  productName: "rotmgtradenode",
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  directories: { output: "release", buildResources: "build" },
  asar: false,
  files: [
    "electron/**",
    "dist/**",
    "public/**",
    "realm-items.json",
    "realm-enchants.json",
    "package.json",
    "!dist/**/*.map",
    "!node_modules/**/test/**",
    "!node_modules/**/*.md",
  ],
  publish,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    signAndEditExecutable: true,
    ...(azureSignOptions ? { azureSignOptions } : {}),
  },
  // One click, for this user only (no admin prompt): shortcuts on the desktop
  // and in the Start menu, the app opens when it is done, and uninstalling
  // keeps the accounts, settings and log in %APPDATA%\rotmgtradenode.
  nsis: {
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    shortcutName: "rotmgtradenode",
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    uninstallDisplayName: "rotmgtradenode",
    artifactName: "${productName}-Setup-${version}.${ext}",
  },
  linux: {
    target: ["AppImage"],
    category: "Game",
    icon: "build/icons",
  },
  mac: {
    target: ["dmg"],
    icon: "build/icon.png",
  },
};
