import { expect, it } from 'vitest';
import { narrowTeammateTasks } from './teammate-tasks-model.js';

const counts = { queued: 0, sending: 0, pending: 1, replied: 0, expired: 0, cancelled: 0 };
const row = (over: Record<string, unknown> = {}) => ({
  jobId: 'RQ-FAKE-1', peer: 'dot', kind: 'review', repo: 'ashlrai/phantom', prRefs: [1], state: 'pending',
  workState: 'RUNNING', deadline: '2026-11-15T13:00:00.000Z', createdAt: '2026-11-15T11:00:00.000Z', ...over });
const payload = (rows: unknown[], over: Record<string, unknown> = {}) =>
  ({ schema: 'imessage.teammate-tasks.v1', asOf: '2026-11-15T12:00:00.000Z', counts, rows, truncated: false, ...over });

it('rejects a wrong schema or malformed counts', () => {
  expect(narrowTeammateTasks(payload([], { schema: 'other.v1' }))).toBeNull();
  expect(narrowTeammateTasks(payload([], { counts: { ...counts, queued: -1 } }))).toBeNull();
  expect(narrowTeammateTasks(payload([], { counts: { queued: 0 } }))).toBeNull();
  expect(narrowTeammateTasks('nope')).toBeNull();
});

it('drops a malformed row and marks the view incomplete', () => {
  const view = narrowTeammateTasks(payload([row(), row({ peer: 'someone' }), 42]))!;
  expect(view.rows).toHaveLength(1);
  expect(view.complete).toBe(false);
  expect(narrowTeammateTasks(payload([row()]))!.complete).toBe(true);
});

it('maps unknown workState to UNKNOWN instead of guessing', () => {
  expect(narrowTeammateTasks(payload([row({ workState: 'VERIFIED' })]))!.rows[0]!.workState).toBe('UNKNOWN');
});
