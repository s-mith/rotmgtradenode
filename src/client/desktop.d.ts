// The desktop app's bridge (electron/preload.cjs): present only inside the
// Windows/macOS/Linux app, absent in a plain browser. Pages check for it
// before offering the desktop-only settings and folder buttons.
export {};

declare global {
  interface DesktopPrefs {
    /** Windows does not go to sleep while the node runs (default on). */
    keepAwake: boolean;
    /** The app starts with Windows, hidden in the tray (default off). */
    startWithWindows: boolean;
  }
  interface DesktopBridge {
    version: string;
    platform: string;
    getPrefs(): Promise<DesktopPrefs>;
    setPrefs(p: Partial<DesktopPrefs>): Promise<DesktopPrefs>;
    openLogFolder(): Promise<void>;
    openDataFolder(): Promise<void>;
  }
  interface Window {
    desktop?: DesktopBridge;
  }
}
