import type { DesktopUpdateState } from '../../../app/desktop-updates.js';

const labels: Record<DesktopUpdateState['phase'], string> = {
  uncommissioned: 'Updates unavailable', disabled: 'Automatic updates off', checking: 'Checking updates',
  idle: 'No update found', available: 'Update available', downloading: 'Downloading update', staged: 'Update prepared',
  'waiting-for-idle': 'Update waits for idle', 'waiting-for-app-quit': 'Update ready on quit',
  'adoption-held': 'Update needs attention', installing: 'Installing update', installed: 'Update installed',
  current: 'Up to date', failed: 'Update check failed',
};

/**
 * Badge and detail for the update status. The native state carries one version (installed when
 * idle/current, the target otherwise) and no check time, so no check time is ever claimed.
 */
export function updateStatusText(state: DesktopUpdateState): { badge: string; detail: string | null } {
  const v = state.version ? `v${state.version}` : null;
  if (state.phase === 'idle' || state.phase === 'current') {
    return {
      badge: v ? `Up to date · ${v}` : 'No newer signed release',
      detail: state.phase === 'idle' ? `No installable signed release newer than ${v ?? 'the installed version'} is on the update feed.` : null,
    };
  }
  return { badge: v ? `${labels[state.phase]} · ${v}` : labels[state.phase], detail: null };
}
