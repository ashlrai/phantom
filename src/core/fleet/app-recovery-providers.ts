/** Runtime provider slot for the fleet apps recovery readers.
 *
 * src/core/verse/fleet-apps-api.ts sits inside the Tier-1 import closure, so it
 * must not import the apps-* implementations itself. Code outside the closure
 * (the web server bootstrap, tests) installs the real readers through
 * app-recovery-install.ts; until then the recovery endpoints report unavailable.
 */
import type { readAppsRecoveryHistory } from './apps-recovery-history.js';
import type { readAppsRecoveryInvocations } from './apps-recovery-invocations.js';
import type { appsRecoveryVerdict } from './apps-recovery-verdict.js';

export interface FleetAppsRecoveryProviders {
  readInvocations: typeof readAppsRecoveryInvocations;
  verdict: typeof appsRecoveryVerdict;
  readHistory: typeof readAppsRecoveryHistory;
}

let providers: FleetAppsRecoveryProviders | null = null;

export function setFleetAppsRecoveryProviders(next: FleetAppsRecoveryProviders): void {
  providers = next;
}

export function fleetAppsRecoveryProviders(): FleetAppsRecoveryProviders | null {
  return providers;
}
