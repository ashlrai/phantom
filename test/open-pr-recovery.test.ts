import { describe, expect, it } from 'vitest';
import { classifyOpenPrRecovery, type OpenPrRecoveryAction } from '../src/core/fleet/merge-plan.js';

const run = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion });
const view = (patch: Record<string, unknown> = {}) => ({
  mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
  autoMergeRequest: null, statusCheckRollup: [run('SUCCESS')], ...patch,
});
const fixtures: [string, unknown, OpenPrRecoveryAction, string][] = [
  ['clean', view(), 'arm-auto-merge', 'clean-unarmed'],
  ['behind', view({ mergeStateStatus: 'BEHIND' }), 'update-branch', 'behind'],
  ['dirty', view({ mergeStateStatus: 'DIRTY' }), 'needs-recut', 'conflict'],
  ['conflicting signal', view({ mergeable: 'CONFLICTING' }), 'needs-recut', 'conflict'],
  ['failed', view({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [run('FAILURE')] }), 'needs-fix', 'failed-check-requiredness-unknown'],
  ['blocked cause unknown', view({ mergeStateStatus: 'BLOCKED' }), 'leave', 'unknown-blocker'],
  ['already armed', view({ autoMergeRequest: { enabledAt: '2026-11-17T12:00:00Z' } }), 'leave', 'already-armed'],
  ['unknown arm', view({ autoMergeRequest: undefined }), 'leave', 'unknown-auto-merge'],
  ['malformed arm', view({ autoMergeRequest: false }), 'leave', 'unknown-auto-merge'],
  ['draft from list', view({ isDraft: true }), 'leave', 'draft'],
  ['draft from view', view({ mergeStateStatus: 'DRAFT' }), 'leave', 'draft'],
  ['malformed draft', view({ isDraft: 'false' }), 'leave', 'unknown-draft-state'],
  ['closed', view({ state: 'CLOSED' }), 'leave', 'not-known-open'],
  ['merged', view({ state: 'MERGED' }), 'leave', 'not-known-open'],
  ['unreadable', null, 'leave', 'unknown-pr'],
  ['array', [], 'leave', 'unknown-pr'],
  ['missing checks', view({ statusCheckRollup: undefined }), 'leave', 'unknown-checks'],
  ['null checks', view({ statusCheckRollup: null }), 'leave', 'unknown-checks'],
  ['empty checks', view({ statusCheckRollup: [] }), 'leave', 'unknown-checks'],
  ['bad entry', view({ statusCheckRollup: [null, run('SUCCESS')] }), 'leave', 'unknown-checks'],
  ['coercible conclusion', view({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: ['SUCCESS'] }] }), 'leave', 'unknown-checks'],
  ['mixed check shapes', view({ statusCheckRollup: [{ ...run('FAILURE'), state: 'SUCCESS' }] }), 'leave', 'unknown-checks'],
  ['running', view({ statusCheckRollup: [run('SUCCESS', 'IN_PROGRESS')] }), 'leave', 'checks-pending-or-unknown'],
  ['unknown mergeability', view({ mergeable: 'UNKNOWN' }), 'leave', 'unknown-mergeability'],
  ['unknown state', view({ mergeStateStatus: 'UNKNOWN' }), 'leave', 'unsupported-merge-state'],
  ['future state', view({ mergeStateStatus: 'FUTURE' }), 'leave', 'unsupported-merge-state'],
];

describe('open PR recovery proposals from gh JSON', () => {
  it.each(fixtures)('%s', (_name, raw, action, reason) => {
    expect(classifyOpenPrRecovery(raw)).toEqual({ action, reason });
  });
  it.each(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])('records completed %s before updating a behind head', conclusion => {
    expect(classifyOpenPrRecovery(view({ mergeStateStatus: 'BEHIND', statusCheckRollup: [run(conclusion)] })).action).toBe('needs-fix');
  });
  it.each(['FAILURE', 'ERROR'])('records legacy status %s', state => {
    expect(classifyOpenPrRecovery(view({ statusCheckRollup: [{ __typename: 'StatusContext', state }] })).action).toBe('needs-fix');
  });
  it.each(['CANCELLED', 'STALE', 'FUTURE'])('leaves %s checks alone', conclusion => {
    expect(classifyOpenPrRecovery(view({ statusCheckRollup: [run(conclusion)] })).action).toBe('leave');
  });
  it('accepts mixed successful contexts, neutral and skipped runs', () => {
    expect(classifyOpenPrRecovery(view({ statusCheckRollup: [run('NEUTRAL'), run('SKIPPED'), { __typename: 'StatusContext', state: 'SUCCESS' }] })).action).toBe('arm-auto-merge');
  });
  it('prioritizes recut over failed checks', () => {
    expect(classifyOpenPrRecovery(view({ mergeStateStatus: 'DIRTY', statusCheckRollup: [run('FAILURE')] })).action).toBe('needs-recut');
  });
  it('updates an armed behind head while its checks are pending', () => {
    expect(classifyOpenPrRecovery(view({ mergeStateStatus: 'BEHIND', autoMergeRequest: {}, statusCheckRollup: [run('', 'QUEUED')] })).action).toBe('update-branch');
  });
  it.each([[null], [run('FUTURE')], [], [{ status: ['QUEUED'] }]])('leaves behind heads with unknown check evidence %#', (...checks) => {
    expect(classifyOpenPrRecovery(view({ mergeStateStatus: 'BEHIND', statusCheckRollup: checks })).action).toBe('leave');
  });
  it('does not hide a failure after pending or malformed check entries', () => {
    expect(classifyOpenPrRecovery(view({ statusCheckRollup: [null, run('', 'QUEUED'), run('FAILURE')] })).action).toBe('needs-fix');
  });
});
