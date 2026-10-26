/** Deterministic local assignment advice. A preference score is not quality, funding or eligibility evidence. */
import type { ProactiveProfile } from './types.js';
import type { CompanionTask } from './coordination-types.js';
import { companionIdentityEqual } from './coordination-types.js';

export interface CompanionCandidate {
  profileId: string; displayName: string; localAssignmentEligible: boolean; executionEligible: false;
  preferencePriority: number; missingCapabilityIds: string[]; reasons: string[];
}
export function rankCompanionCandidates(task: CompanionTask, profiles: readonly ProactiveProfile[], tasks: readonly CompanionTask[]): CompanionCandidate[] {
  return profiles.map(profile => {
    const missingCapabilityIds = task.capabilityIds.filter(id => !profile.capabilityIds.includes(id));
    const active = tasks.filter(value => {
      const attempt = value.attempts.at(-1);
      return attempt && companionIdentityEqual(attempt.assignee, profile.identity)
        && !['verified', 'draft'].includes(value.state)
        && !['proved-unstarted', 'cancel-confirmed'].includes(attempt.contact);
    }).length;
    const reasons = [
      ...(!profile.enabled ? ['Profile planning preference is disabled.'] : []),
      ...(missingCapabilityIds.length ? ['Required capabilities have not been declared.'] : []),
      ...(profile.preferences.projectBindingIds.length && !profile.preferences.projectBindingIds.includes(task.projectBindingId)
        ? ['Project does not match the saved preference.'] : []),
      ...(active >= profile.preferences.maxConcurrent ? ['Local assignment concurrency preference is reached.'] : []),
    ];
    return { profileId: profile.id, displayName: profile.displayName, localAssignmentEligible: reasons.length === 0,
      executionEligible: false as const, preferencePriority: profile.preferences.priority, missingCapabilityIds,
      reasons: [...reasons, 'Capabilities are declared; provider transport and execution are unqualified.'] };
  }).sort((a, b) => Number(b.localAssignmentEligible) - Number(a.localAssignmentEligible)
    || b.preferencePriority - a.preferencePriority || a.profileId.localeCompare(b.profileId));
}
