/**
 * app/update-reload-model.ts — pure decision for the "Phantom updated —
 * Reload" banner (UpdateReloadBanner.tsx). The status route
 * (GET /api/verse/ops/self-update → OpsSelfUpdateV1) already reports the
 * server's build; this decides when the page's own interface is stale.
 *
 * Two triggers, in precedence order:
 *   - interface-behind: the server reports a different installedVersion
 *     than this page was built from — the running server is newer code and
 *     the page still shows the old interface build.
 *   - server-restarted: the server's commit (headSha) changed since the
 *     page's first healthy reading — the sidecar restarted on new code,
 *     version number or not.
 *
 * Never a banner for a missing/unavailable reading, and never again for a
 * headSha the operator already dismissed with "Later".
 */
import type { OpsSelfUpdateV1 } from '../../core/verse/ops-types.js';
import { PRODUCT_NAME } from './product-brand.js';

/** The fields decideReload reads; OpsSelfUpdateV1 satisfies it structurally. */
export type UpdateReloadReading = Pick<OpsSelfUpdateV1, 'installedVersion' | 'headSha' | 'sourceState'>;

export type ReloadDecision =
  | { show: false }
  | { show: true; reason: 'interface-behind' | 'server-restarted'; message: string; sha: string | null };

export interface DecideReloadInput {
  /** The first healthy reading captured after page load — the restart baseline. */
  first: UpdateReloadReading | null;
  /** The newest reading. */
  current: UpdateReloadReading | null;
  /** This page's own interface build version. */
  appVersion: string;
  /** The headSha the operator dismissed with "Later"; null when none. */
  dismissedSha: string | null;
}

export function decideReload({ first, current, appVersion, dismissedSha }: DecideReloadInput): ReloadDecision {
  if (!current || current.sourceState === 'unavailable') return { show: false };
  const sha = typeof current.headSha === 'string' ? current.headSha : null;
  // "Later" is keyed on the commit it dismissed: a further change asks again.
  if (sha !== null && dismissedSha === sha) return { show: false };
  if (typeof current.installedVersion === 'string' && current.installedVersion !== appVersion) {
    return {
      show: true,
      reason: 'interface-behind',
      message: `${PRODUCT_NAME} updated to ${current.installedVersion} — reload to use the new interface`,
      sha,
    };
  }
  if (first && typeof first.headSha === 'string' && sha !== null && first.headSha !== sha) {
    return {
      show: true,
      reason: 'server-restarted',
      message: `${PRODUCT_NAME} restarted on new code — reload`,
      sha,
    };
  }
  return { show: false };
}
