// The desktop shell (design doc §4.1). Electron here is a tray icon, a
// window, an auto-updater and a keychain; the node itself is the same Hono
// server `npm start` runs, spawned as a child with Electron's own Node so
// one install carries everything. Nothing in this file touches the game.
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, safeStorage, shell } from "electron";
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

let child = null;
let win = null;
let tray = null;
let port = 0;
let quitting = false;

// One instance: a second launch just shows the first one's window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());

/**
 * The sealing key for credentials at rest (src/node/secrets.ts). Kept in
 * the OS keychain through safeStorage; the file on disk is the keychain's
 * ciphertext, useless without this user's login. Where no keychain exists
 * (some Linux setups) safeStorage falls back to a weaker scheme and says so.
 */
function secretKey() {
  const file = path.join(app.getPath("userData"), "secret_key.enc");
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(fs.readFileSync(file)).trim();
    } catch {
      const key = randomBytes(32).toString("base64");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, safeStorage.encryptString(key));
      return key;
    }
  }
  return ""; // the server falls back to its 0600 key file in the data dir
}

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
    if (quitting) return;
    dialog.showErrorBox("rotmgtradenode stopped", `The node process exited (code ${code}). See ${logFile}.`);
    app.quit();
  });
  // Wait for /api/healthz before showing anything.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
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

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280, height: 860, title: "rotmgtradenode", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  // Links to the outside (Discord, Realm's site) open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Closing the window keeps the node running in the tray: the bots stay logged in.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on("closed", () => { win = null; });
}

function makeTray() {
  const icon = nativeImage.createFromPath(path.join(appRoot, "public", "logo.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("rotmgtradenode");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open rotmgtradenode", click: showWindow },
    { label: "Control panel", click: () => { showWindow(); win?.loadURL(`http://127.0.0.1:${port}/control`); } },
    { label: "Open data folder", click: () => shell.openPath(app.getPath("userData")) },
    { label: "Open log", click: () => shell.openPath(logFile) },
    { type: "separator" },
    { label: "Quit (logs every account out)", click: () => app.quit() },
  ]));
  tray.on("click", showWindow);
}

async function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.logger = null;
    autoUpdater.on("update-downloaded", (info) => {
      dialog.showMessageBox({ type: "info", message: `rotmgtradenode ${info.version} is ready.`, detail: "It installs the next time you quit. Realm updates arrive this way too (design doc §8).", buttons: ["OK"] });
    });
    await autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000).unref();
  } catch (e) {
    fs.appendFileSync(logFile, `[shell] update check failed: ${e}\n`);
  }
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox("rotmgtradenode could not start", `${e}\n\nLog: ${logFile}`);
    app.quit();
    return;
  }
  makeTray();
  showWindow();
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
  fetch(`http://127.0.0.1:${port}/api/dev/shutdown`, { method: "POST" }).catch(() => { clearTimeout(timer); child?.kill("SIGTERM"); setTimeout(done, 3_000); });
});
