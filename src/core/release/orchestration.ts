/** Evidence-driven release orchestration. This module performs no external effects. */
export interface ReleaseCandidate {
  repository: string;
  sourceSha: string;
  version: string;
  workflow: string;
}

export type ReleaseState =
  | { phase: 'detect' }
  | { phase: 'gates'; candidate: ReleaseCandidate }
  | { phase: 'dispatch'; candidate: ReleaseCandidate }
  | { phase: 'reconcile-dispatch'; candidate: ReleaseCandidate }
  | { phase: 'publication'; candidate: ReleaseCandidate; runId: string }
  | { phase: 'published'; candidate: ReleaseCandidate; runId: string }
  | { phase: 'held'; candidate: ReleaseCandidate; reason: string }
  | { phase: 'rollback-signal'; candidate: ReleaseCandidate; runId: string; reason: string };

export type ReleaseEvent =
  | { type: 'detected'; candidate: ReleaseCandidate }
  | { type: 'gates'; candidate: ReleaseCandidate; checks: 'pass' | 'fail' | 'unknown'; grant: 'allowed' | 'denied' | 'unknown'; workflow: 'sanctioned' | 'unknown'; ownerReserved: 'clear' | 'blocked' | 'unknown' }
  | { type: 'dispatch-started' }
  | { type: 'dispatch-result'; candidate: ReleaseCandidate; outcome: 'accepted'; runId: string }
  | { type: 'dispatch-result'; candidate: ReleaseCandidate; outcome: 'unknown' | 'refused' }
  | { type: 'publication'; candidate: ReleaseCandidate; runId: string; outcome: 'verified' | 'pending' | 'failed' | 'unknown' };

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/;
const RUN = /^[1-9]\d*$/;

function validCandidate(c: ReleaseCandidate): boolean {
  return !!c && REPO.test(c.repository) && SHA.test(c.sourceSha) && VERSION.test(c.version) && WORKFLOW.test(c.workflow);
}
function same(a: ReleaseCandidate, b: ReleaseCandidate): boolean {
  return validCandidate(b) && a.repository === b.repository && a.sourceSha === b.sourceSha && a.version === b.version && a.workflow === b.workflow;
}

/** Apply one observation. Invalid, out-of-order, or mismatched events throw. Persist
 * reconcile-dispatch before invoking a workflow; uncertainty must be reconciled,
 * never retried blindly. Gate observations are not themselves authorization. */
export function advanceRelease(state: ReleaseState, event: ReleaseEvent): ReleaseState {
  if (state.phase === 'detect' && event.type === 'detected' && validCandidate(event.candidate)) {
    return { phase: 'gates', candidate: { ...event.candidate } };
  }
  if (state.phase === 'gates' && event.type === 'gates' && same(state.candidate, event.candidate)) {
    if (event.checks !== 'pass' || event.grant !== 'allowed' || event.workflow !== 'sanctioned' || event.ownerReserved !== 'clear') {
      return { phase: 'held', candidate: state.candidate, reason: 'gates-not-confirmed' };
    }
    return { phase: 'dispatch', candidate: state.candidate };
  }
  if (state.phase === 'dispatch' && event.type === 'dispatch-started') return { phase: 'reconcile-dispatch', candidate: state.candidate };
  if (state.phase === 'reconcile-dispatch' && event.type === 'dispatch-result' && same(state.candidate, event.candidate)) {
    if (event.outcome === 'unknown') return state;
    if (event.outcome === 'refused') return { phase: 'held', candidate: state.candidate, reason: 'dispatch-refused' };
    if (event.outcome === 'accepted' && RUN.test(event.runId)) return { phase: 'publication', candidate: state.candidate, runId: event.runId };
  }
  if (state.phase === 'publication' && event.type === 'publication' && same(state.candidate, event.candidate) && state.runId === event.runId) {
    if (event.outcome === 'pending' || event.outcome === 'unknown') return state;
    if (event.outcome === 'verified') return { ...state, phase: 'published' };
    if (event.outcome === 'failed') return { ...state, phase: 'rollback-signal', reason: 'publication-failed' };
  }
  throw new Error('Invalid release transition or mismatched evidence');
}
