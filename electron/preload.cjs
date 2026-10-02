// The desktop bridge: what the node's pages may ask of the app around them
// (window.desktop). Sandboxed, so only Electron's contextBridge and
// ipcRenderer are at hand; every call is checked again in electron/main.mjs.
// In a plain browser there is no window.desktop and the pages leave these out.
const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("desktop:info") || {};

contextBridge.exposeInMainWorld("desktop", {
  version: String(info.version || ""),
  platform: String(info.platform || ""),
  /** { keepAwake, startWithWindows } */
  getPrefs: () => ipcRenderer.invoke("desktop:get-prefs"),
  /** Only the booleans keepAwake and startWithWindows are taken; the answer is the prefs as they now stand. */
  setPrefs: (p) => ipcRenderer.invoke("desktop:set-prefs", p),
  openLogFolder: () => ipcRenderer.invoke("desktop:open-log-folder"),
  openDataFolder: () => ipcRenderer.invoke("desktop:open-data-folder"),
});
