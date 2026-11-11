/** Installs the real fleet apps recovery readers into the provider slot.
 *
 * This module is intentionally imported only by code outside the Tier-1
 * closure (src/core/web/server.ts, tests): its literal dynamic imports of the
 * apps-* implementations must never become reachable from Tier-1 roots.
 */
import { setFleetAppsRecoveryProviders } from './app-recovery-providers.js';

export async function installFleetAppsRecoveryProviders(): Promise<void> {
  const [invocations, verdict, history] = await Promise.all([
    import('./apps-recovery-invocations.js'),
    import('./apps-recovery-verdict.js'),
    import('./apps-recovery-history.js'),
  ]);
  setFleetAppsRecoveryProviders({
    readInvocations: invocations.readAppsRecoveryInvocations,
    verdict: verdict.appsRecoveryVerdict,
    readHistory: history.readAppsRecoveryHistory,
  });
}
