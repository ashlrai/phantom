export const DESKTOP_UPDATE_REASONS: Record<string, string> = {
  'grant-unavailable': 'This installed update host requires an active grant. Use the managed CLI upgrade.',
  'authority-reapproval-required': 'This installed update host requires the same authority surface. Use the managed CLI upgrade.',
  'candidate-not-newer': 'The candidate does not supersede the installed release or match the CLI revision for app repair.',
  'app-version-unverified': 'The signed installed app version could not be verified.',
  'resident-stop-failed': 'The resident service could not be stopped. Installation waits.',
  'stop-required': 'Stop the fleet and finish local work before installing.',
  'work-active-or-unknown': 'Local work is active or its state could not be confirmed. Installation waits.',
  'native-parent-changed-or-unknown': 'The desktop process could not be confirmed. Installation stays on hold.',
  'artifact-mismatch': 'The downloaded bytes did not match the signed release. Installation stays on hold.',
  'preference-save-failed': 'The setting could not be saved. It may change back after quitting.',
  'operator-restart-required': 'Restart the fleet from Fleet when you are ready.',
};
export function describeDesktopUpdateReason(reason: string | null | undefined): string {
  if (reason == null) return 'reason unavailable';
  if (Object.hasOwn(DESKTOP_UPDATE_REASONS, reason)) return DESKTOP_UPDATE_REASONS[reason]!;
  const words = reason.replace(/-/gu, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
