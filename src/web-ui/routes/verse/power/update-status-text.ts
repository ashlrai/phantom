import type { DesktopUpdateState } from '../../../app/desktop-updates.js';

const labels: Record<DesktopUpdateState['phase'], string> = {
  uncommissioned: 'Updates unavailable', disabled: 'Automatic updates off', checking: 'Checking updates',
  idle: 'No update found', available: 'Update available', downloading: 'Downloading update', staged: 'Update prepared',
  'waiting-for-idle': 'Update waits for idle', 'waiting-for-app-quit': 'Update ready on quit',
  'adoption-held': 'Update needs attention', installing: 'Installing update', installed: 'Update installed',
  current: 'Up to date', failed: 'Update check failed',
};

type FeedObservation = { feed?: { status: 'ok' | 'unavailable' | 'missing-assets'; newestVersion?: string } };

/**
 * Badge and detail for the update status. The native state carries one version (installed when
 * idle/current, the target otherwise) and no check time, so no check time is ever claimed.
 */
export function updateStatusText(state: DesktopUpdateState & FeedObservation): { badge: string; detail: string | null } {
  const v = state.version ? `v${state.version}` : null;
  if (state.phase === 'idle' || state.phase === 'current') {
    if (state.feed?.status === 'unavailable' || state.feed?.status === 'missing-assets') {
      const newest = state.feed.newestVersion;
      return {
        badge: v ? `Update feed unavailable · ${v}` : 'Update feed unavailable',
        detail: state.feed.status === 'missing-assets' && newest
          ? `Newest release v${newest} has no desktop update files yet; this app stays on ${v ?? 'the installed version'}.`
          : 'The desktop update feed is unavailable; the latest release could not be checked.',
      };
    }
    if (state.feed?.status !== 'ok') {
      return { badge: v ? `${v} · last check result unknown` : 'Last check result unknown', detail: null };
    }
    return {
      badge: v ? `Up to date · ${v}` : 'No newer signed release',
      detail: state.phase === 'idle' ? `No installable signed release newer than ${v ?? 'the installed version'} is on the update feed.` : null,
    };
  }
  return { badge: v ? `${labels[state.phase]} · ${v}` : labels[state.phase], detail: null };
}
