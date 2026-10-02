// Advanced management (docs/relay/ADVANCED.md) as the site's side reads it:
// the owner's node setting, registered by the process that runs the fleet.
// Without a registration (tests, a process with no fleet) both pools are off,
// so everything behaves as before.
import { advancedFor, DEFAULT_ADVANCED, type AdvancedManagement } from "../node/settings";

let getter: (() => AdvancedManagement) | null = null;
export function registerAdvancedSettings(get: (() => AdvancedManagement) | null): void {
  getter = get;
}
/** The advanced management settings now (live: the owner may switch them while the node runs). */
export function advancedSettings(): AdvancedManagement {
  return getter ? getter() : DEFAULT_ADVANCED;
}
/** Whether the accounts of this pool (communism or standard) follow the advanced rules. */
export function advancedForPool(communism: boolean): boolean {
  return advancedFor(advancedSettings(), communism);
}
