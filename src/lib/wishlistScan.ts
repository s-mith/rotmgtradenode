import { getDb } from "./db";
import { pyrelay } from "./devauth";
import { onPoolChanged } from "./liveBus";
import { anyRulesEnabled, scanWishlists, type ScanResult } from "./wishlist";

// Drives lib/wishlist.ts against the live pool. Two triggers: the pool-changed
// signal (the embedded fleet raises it on every inventory change, and claims
// and donates raise it themselves), debounced so a burst of trades costs one
// scan; and a slow interval as the backstop for a relay reached over HTTP,
// which announces nothing. A scan is skipped outright while no rule is
// enabled, so an idle site never fetches the pool for this.

const DEBOUNCE_MS = 1_500;
const INTERVAL_MS = 30_000;

let running = false;
let rerun = false;
let debounce: NodeJS.Timeout | null = null;
let interval: NodeJS.Timeout | null = null;
let installed = false;

export async function runWishlistScan(): Promise<ScanResult | null> {
  if (running) {
    rerun = true;
    return null;
  }
  running = true;
  try {
    const db = getDb();
    if (!anyRulesEnabled(db)) return null;
    const pool = await pyrelay.pool();
    if (!pool.ok) return null;
    const result = scanWishlists(db, pool.data);
    if (result.hits.length) {
      console.log(`[wishlist] claimed ${result.hits.length} item(s): ${result.hits.map((h) => `${h.itemId}→user ${h.userId} (rule ${h.ruleId})`).join(", ")}`);
    }
    for (const s of result.skipped) console.log(`[wishlist] rule ${s.ruleId} skipped ${s.instanceId}: ${s.why}`);
    return result;
  } catch (e) {
    console.error("[wishlist] scan failed:", e);
    return null;
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      scheduleWishlistScan();
    }
  }
}

export function scheduleWishlistScan(): void {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    void runWishlistScan();
  }, DEBOUNCE_MS);
  debounce.unref?.();
}

/** Wire the scanner to the pool-changed signal and the interval. Once per process. */
export function installWishlistScanner(): void {
  if (installed) return;
  installed = true;
  onPoolChanged(scheduleWishlistScan);
  interval = setInterval(() => void runWishlistScan(), INTERVAL_MS);
  interval.unref?.();
}

export function stopWishlistScanner(): void {
  if (interval) clearInterval(interval);
  if (debounce) clearTimeout(debounce);
  interval = null;
  debounce = null;
  installed = false;
}
