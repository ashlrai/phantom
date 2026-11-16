import type { LearningStateV1 } from '../../../../core/learn/harness-types.js';

export function rollbackTarget(state: LearningStateV1): { toVersionId: string | null; label: string } | null {
  if (!state.active) return null;
  const index = state.versions.findIndex(version => version.id === state.active!.id);
  const previous = index > 0 ? state.versions[index - 1] : null;
  return previous && previous.status !== 'baseline'
    ? { toVersionId: previous.id, label: previous.id }
    : { toVersionId: null, label: 'Baseline' };
}

export function runningExperiments(state: LearningStateV1) {
  return state.experiments.filter(experiment => experiment.status === 'queued' || experiment.status === 'running');
}

export function harnessActionOutcome(status: number, error?: string | null): string {
  if (status === 200) return 'Harness change complete.';
  if (status === 401 || status === 403) return 'Unlock to change the harness.';
  if (status === 404) return 'This Phantom build cannot change the harness from the app.';
  if (status === 409 && error) return error;
  return 'Could not do that. Try again.';
}
