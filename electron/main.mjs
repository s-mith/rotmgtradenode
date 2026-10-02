// The desktop shell (design doc §4.1). Electron here is a tray icon, a
// window, an auto-updater and a keychain; the node itself is the same Hono
// server `npm start` runs, spawned as a child with Electron's own Node so
// one install carries everything. Nothing in this file touches the game.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const serverMain = path.join(appRoot, "dist", "server", "main.js");
const clientDir = path.join(appRoot, "dist", "client");
const APP_ID = "trade.rotmg.rotmgtradenode";
// The app was called "rotmgtrade" until 2026-09-17. Its data folder moves
// over once: whole when this one does not exist yet, otherwise piece by
// piece for whatever is still missing here.
const legacyUserData = path.join(app.getPath("appData"), "rotmgtrade");
if (fs.existsSync(legacyUserData) && legacyUserData !== app.getPath("userData")) {
  try {
    const target = app.getPath("userData");
    if (!fs.existsSync(target)) fs.renameSync(legacyUserData, target);
    else {
      for (const name of ["data", "secret_key.enc", "node.log"]) {
        const from = path.join(legacyUserData, name);
        const to = path.join(target, name);
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
      }
    }
  } catch (e) {
    console.error("could not move the old rotmgtrade data folder:", e);
  }
}
const dataDir = path.join(app.getPath("userData"), "data");
const logFile = path.join(app.getPath("userData"), "node.log");
const prefsFile = path.join(app.getPath("userData"), "desktop.json");
/** Started by Windows at sign-in ("Start with Windows"): the tray only, no window. */
const startHidden = process.argv.includes("--hidden");

let child = null;
let win = null;
let tray = null;
let port = 0;
let quitting = false;
/** Until the node first answers: a crash then is told as "could not start", once. */
let starting = true;
/** The page the window opens on: the setup steps until they are done, then the control panel. */
let landing = "/control";

// One instance: a second launch just shows the first one's window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());
// Windows shows notifications only for an app with an id (the installer's shortcut carries the same one).
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/** A line in the log next to the node's own, for what the shell did. */
function shellLog(line) {
  try {
    fs.appendFileSync(logFile, `[shell] ${new Date().toISOString()} ${line}\n`);
  } catch {
    // nowhere to say it
  }
}

// --- the owner's desktop settings (desktop.json) -------------------------------

/**
 * keepAwake: Windows does not put the computer to sleep while the node runs
 * (bots would drop out of their trades). startWithWindows: the app starts at
 * sign-in, in the tray. trayNoticeShown: the "still running" notice was seen.
 */
function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
    return { keepAwake: raw.keepAwake !== false, startWithWindows: raw.startWithWindows === true, trayNoticeShown: raw.trayNoticeShown === true };
  } catch {
    return { keepAwake: true, startWithWindows: false, trayNoticeShown: false };
  }
}
let prefs = loadPrefs();
function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
    fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2) + "\n");
  } catch (e) {
    shellLog(`could not save ${prefsFile}: ${e?.message ?? e}`);
  }
}
/** Starting at sign-in is a Windows (and macOS) registration of the installed app; elsewhere, and when run from source, it is not offered. */
const canStartAtLogin = () => app.isPackaged && (process.platform === "win32" || process.platform === "darwin");

let awakeBlocker = null;
function applyKeepAwake() {
  if (prefs.keepAwake && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
  else if (!prefs.keepAwake && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
}
function applyStartAtLogin() {
  if (!canStartAtLogin()) return;
  app.setLoginItemSettings({ openAtLogin: prefs.startWithWindows, args: ["--hidden"] });
}
/** What the pages see: the two settings, the second as Windows has it (the owner may have turned it off in Task Manager). */
function publicPrefs() {
  let startWithWindows = prefs.startWithWindows;
  if (canStartAtLogin()) {
    try {
      startWithWindows = app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
    } catch {
      // keep the stored answer
    }
  }
  return { keepAwake: prefs.keepAwake, startWithWindows };
}

// --- the node ------------------------------------------------------------------

/**
 * The sealing key for credentials at rest (src/node/secrets.ts). Kept in
 * the OS keychain through safeStorage; the file on disk is the keychain's
 * ciphertext, useless without this user's login. Where no keychain exists
 * (some Linux setups) safeStorage falls back to a weaker scheme and says so.
 */
function secretKey() {
  const file = path.join(app.getPath("userData"), "secret_key.enc");
  if (safeStorage.isEncryptionAvailable()) {
    // A new key only on first run. A key file the keychain cannot open (a
    // locked keyring, a changed keyring backend, a restored profile) is an
    // error: replacing it would make every sealed password unreadable for good.
    if (!fs.existsSync(file)) {
      const key = randomBytes(32).toString("base64");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, safeStorage.encryptString(key));
      return key;
    }
    try {
      return safeStorage.decryptString(fs.readFileSync(file)).trim();
    } catch (e) {
      throw new KeychainError(`The OS keychain could not open ${file} (${e?.message ?? e}). Unlock your keyring and start again; the stored account passwords need that key, so a new one is not made.`);
    }
  }
  return ""; // the server falls back to its 0600 key file in the data dir
}
class KeychainError extends Error {}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

/** What the shell sends the node's control panel API: the password, when the owner set one. */
function devHeaders(json = false) {
  return { ...(json ? { "content-type": "application/json" } : {}), "x-dev-password": process.env.DEV_PASSWORD ?? "" };
}

async function startServer() {
  port = await freePort();
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ROTMGTRADE_DATA_DIR: dataDir,
    ROTMGTRADE_SECRET_KEY: secretKey(),
    ROTMGTRADE_VERSION: app.getVersion(),
    CLIENT_DIR: clientDir,
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
  };
  // cwd = the app root: the server reads realm-items.json and
  // realm-enchants.json from there.
  child = spawn(process.execPath, [serverMain], { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", (code) => {
    child = null;
    shellLog(`the node process exited (code ${code})`);
    if (quitting || starting) return;
    dialog.showErrorBox(
      "rotmgtradenode stopped",
      "rotmgtradenode stopped unexpectedly, and your bots were logged out.\n\n" +
        "Open it again from the Start menu or the desktop shortcut.\n\n" +
        `If it keeps stopping, send this file to the rotmg trade Discord so we can help:\n${logFile}`,
    );
    app.quit();
  });
  // Wait for /api/healthz before showing anything.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!child) throw new Error("the node process exited while starting");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the node did not come up in 30s");
}

/** The setup steps until the node says they are done, else the control panel (also when the node is too old to say). */
async function landingPath() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/dev/setup`, { headers: devHeaders() });
    if (!r.ok) return "/control";
    const body = await r.json();
    return body && body.complete === false ? "/setup" : "/control";
  } catch {
    return "/control";
  }
}

// --- the window ----------------------------------------------------------------

/** Show the window, on `page` when given (a path on the node, like "/help"). */
function showWindow(page) {
  if (!port) return;
  if (win) {
    if (page) void win.loadURL(`http://127.0.0.1:${port}${page}`);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280, height: 860, title: "rotmgtradenode", autoHideMenuBar: true,
    icon: path.join(here, "tray@2x.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(here, "preload.cjs") },
  });
  void win.loadURL(`http://127.0.0.1:${port}${page ?? landing}`);
  // Links to the outside (Discord, Realm's site) open in the browser; only
  // web links, never file:, smb: or a custom protocol handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocalUrl(url) && isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window itself only ever shows the node.
  win.webContents.on("will-navigate", (e, url) => {
    if (isLocalUrl(url)) return;
    e.preventDefault();
    if (isWebUrl(url)) void shell.openExternal(url);
  });
  // Closing the window keeps the node running in the tray: the bots stay logged in.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    trayNotice();
  });
  win.on("closed", () => { win = null; });
}

/** Once: closing the window does not stop the node, and here is how to. */
function trayNotice() {
  if (prefs.trayNoticeShown || !Notification.isSupported()) return;
  new Notification({
    title: "rotmgtradenode is still running in the tray",
    body: "Your bots stay online. To stop it, right-click the rotmgtradenode icon by the clock and choose Quit.",
    icon: path.join(here, "tray@2x.png"),
  }).show();
  prefs.trayNoticeShown = true;
  savePrefs();
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
function isLocalUrl(url) {
  const u = parseUrl(url);
  return !!u && u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port === String(port) && !u.username && !u.password;
}
function isWebUrl(url) {
  const u = parseUrl(url);
  return !!u && (u.protocol === "https:" || u.protocol === "http:");
}

function makeTray() {
  let icon = nativeImage.createFromPath(path.join(here, "tray.png"));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(appRoot, "public", "logo.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("rotmgtradenode");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open rotmgtradenode", click: () => showWindow() },
    { label: "Open control panel", click: () => showWindow("/control") },
    { label: "Help", click: () => showWindow("/help") },
    { type: "separator" },
    { label: "Open data folder", click: () => shell.openPath(app.getPath("userData")) },
    { label: "Open log", click: () => shell.openPath(logFile) },
    { type: "separator" },
    { label: "Quit (logs every account out)", click: () => app.quit() },
  ]));
  tray.on("click", () => showWindow());
}

// --- the desktop bridge (electron/preload.cjs) ----------------------------------

/** Only the node's own pages, in this app's window, may use the bridge. */
function fromNode(e) {
  return isLocalUrl(e.senderFrame?.url ?? "");
}
ipcMain.on("desktop:info", (e) => {
  e.returnValue = fromNode(e) ? { version: app.getVersion(), platform: process.platform } : null;
});
ipcMain.handle("desktop:get-prefs", (e) => {
  if (!fromNode(e)) throw new Error("not allowed");
  return publicPrefs();
});
ipcMain.handle("desktop:set-prefs", (e, p) => {
  if (!fromNode(e)) throw new Error("not allowed");
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("expected { keepAwake?, startWithWindows? }");
  if (typeof p.keepAwake === "boolean") prefs.keepAwake = p.keepAwake;
  if (typeof p.startWithWindows === "boolean") prefs.startWithWindows = p.startWithWindows;
  savePrefs();
  applyKeepAwake();
  applyStartAtLogin();
  shellLog(`settings: keep awake ${prefs.keepAwake ? "on" : "off"}, start with Windows ${prefs.startWithWindows ? "on" : "off"}`);
  return publicPrefs();
});
ipcMain.handle("desktop:open-log-folder", (e) => {
  if (!fromNode(e)) throw new Error("not allowed");
  shell.showItemInFolder(logFile);
});
ipcMain.handle("desktop:open-data-folder", (e) => {
  if (!fromNode(e)) throw new Error("not allowed");
  return shell.openPath(app.getPath("userData")).then(() => undefined);
});

// --- updates, sleep -------------------------------------------------------------

async function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    // electron-updater is CommonJS with `autoUpdater` behind a getter, which an
    // ES import does not see as a named export: take it off the module itself.
    const mod = await import("electron-updater");
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!autoUpdater) throw new Error("electron-updater has no autoUpdater");
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => shellLog("checking for an update"));
    autoUpdater.on("update-not-available", (info) => shellLog(`up to date (${info?.version ?? app.getVersion()})`));
    autoUpdater.on("update-available", (info) => shellLog(`downloading update ${info?.version}`));
    autoUpdater.on("error", (e) => shellLog(`update check failed: ${e?.message ?? e}`));
    autoUpdater.on("update-downloaded", (info) => {
      dialog.showMessageBox({ type: "info", message: `An update for rotmgtradenode is ready (${info.version}).`, detail: "It installs the next time you quit rotmgtradenode from the tray icon. Updates also bring support for new versions of the game.", buttons: ["OK"] });
    });
    // An unpacked build, or a Linux build not run as its AppImage, has nothing to update.
    if (typeof autoUpdater.isUpdaterActive === "function" && !autoUpdater.isUpdaterActive()) {
      shellLog("updates are off for this copy (not an installed build)");
      return;
    }
    await autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000).unref();
  } catch (e) {
    shellLog(`update check failed: ${e?.message ?? e}`);
  }
}

// After the computer wakes up the bots' connections are stale: the node logs
// them back in cleanly instead of waiting for each to time out.
function onResume() {
  if (!child || !port) return;
  shellLog("the computer woke up: asking the node to reconnect its bots");
  fetch(`http://127.0.0.1:${port}/api/dev/node`, { method: "POST", headers: devHeaders(true), body: JSON.stringify({ action: "resume" }) })
    .then((r) => { if (!r.ok) shellLog(`resume: the node answered ${r.status}`); })
    .catch((e) => shellLog(`resume: ${e?.message ?? e}`));
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (e) {
    shellLog(`could not start: ${e?.message ?? e}`);
    const keychain = e instanceof KeychainError;
    dialog.showErrorBox(
      "rotmgtradenode could not start",
      (keychain
        ? "Your computer's password store would not open the key that protects your saved account passwords.\n\nSign out of your computer, sign back in, and open rotmgtradenode again.\n\n"
        : "Something stopped rotmgtradenode from starting.\n\nTry this:\n• Restart your computer, then open rotmgtradenode again.\n• If your antivirus moved rotmgtradenode to quarantine, restore it and allow it.\n• Install the latest version from the rotmg trade website.\n\n") +
        `If it still won't start, send this file to the rotmg trade Discord so we can help:\n${logFile}`,
    );
    app.quit();
    return;
  }
  starting = false;
  landing = await landingPath();
  powerMonitor.on("resume", onResume);
  applyKeepAwake();
  applyStartAtLogin();
  makeTray();
  if (!startHidden) showWindow();
  void checkForUpdates();
});

app.on("window-all-closed", () => {
  // Stay in the tray; quitting is explicit.
});
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  if (!child) return;
  // Ask the node to stop the way a SIGTERM would; on Windows a child cannot
  // be signalled, so this endpoint is the only graceful path. Give it a few
  // seconds to flush state and log the bots out, then quit for real.
  e.preventDefault();
  const done = () => { try { child?.kill(); } catch {} app.quit(); };
  const timer = setTimeout(done, 8_000);
  child.once("exit", () => { clearTimeout(timer); done(); });
  // The child has the same environment, so a DEV_PASSWORD set there is the one it checks.
  const fallback = () => { clearTimeout(timer); child?.kill("SIGTERM"); setTimeout(done, 3_000); };
  fetch(`http://127.0.0.1:${port}/api/dev/shutdown`, {
    method: "POST",
    headers: devHeaders(true),
    body: "{}",
  }).then((r) => { if (!r.ok) fallback(); }, fallback);
});
