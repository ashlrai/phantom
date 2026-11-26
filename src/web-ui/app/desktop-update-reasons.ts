export const DESKTOP_UPDATE_REASONS: Record<string, string> = {
  'grant-unavailable': 'This installed update host requires an active grant. Use the managed CLI upgrade.',
  'authority-reapproval-required': 'This installed update host requires the same authority surface. Use the managed CLI upgrade.',
  'candidate-not-newer': 'The candidate does not supersede the installed release or match the CLI revision for app repair.',
  'app-version-unverified': 'The signed installed app version could not be verified.',
  'resident-stop-failed': 'The resident service could not be stopped. Installation waits.',
  'stop-required': 'Stop the fleet and finish local work before installing.',
  'drain-interlock-unsupported': 'Local interlock support could not be verified. Stop the fleet and finish local work before installing.',
  'work-active-or-unknown': 'Local work is active or its state could not be confirmed. Installation waits.',
  'native-parent-changed-or-unknown': 'The desktop process could not be confirmed. Installation stays on hold.',
  'artifact-mismatch': 'The downloaded bytes did not match the signed release. Installation stays on hold.',
  'preference-save-failed': 'The setting could not be saved. It may change back after quitting.',
  'operator-restart-required': 'Restart the fleet from Fleet when you are ready.',
  'owned-pause-aborted': 'The update did not switch releases. The previous resident was restored.',
  'owned-pause-cap-expired': 'The pause budget expired before switching. The previous resident was restored.',
  'waiting-for-low-activity': 'Queued work is waiting. The update will recheck for a quiet window.',
  'resume-abort-unverified': 'The previous installation could not be verified. The fleet stays paused.',
  'resume-grant-changed': 'The standing grant changed. Review it in Fleet before resuming.',
  'resume-install-unverified': 'The installed release could not be verified. The fleet stays paused.',
  'resume-local-pause-unverified': 'The local release-train pause could not be restored safely.',
  'resume-ownership-lost': 'The update no longer owns the pause. Check operator Stop before resuming.',
  'resume-resident-unverified': 'The managed resident could not be verified or restarted.',
  'resume-surface-changed': 'The authority surface changed. Review and approve it before resuming.',
};
export function describeDesktopUpdateReason(reason: string | null | undefined): string {
  if (reason == null) return 'reason unavailable';
  if (Object.hasOwn(DESKTOP_UPDATE_REASONS, reason)) return DESKTOP_UPDATE_REASONS[reason]!;
  const words = reason.replace(/-/gu, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
