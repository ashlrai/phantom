import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowTeammateTasks } from './teammate-tasks-model.js';
import { TeammateTasksBody } from './TeammateTasksCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-15T12:00:00Z');
const STATES = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'REPORTED_DONE', 'BLOCKED', 'CANCELLED'];
const counts = { queued: 0, sending: 0, pending: 6, replied: 0, expired: 0, cancelled: 0 };
const mk = (rows: unknown[]) => narrowTeammateTasks({ schema: 'imessage.teammate-tasks.v1', asOf: '2026-11-15T12:00:00.000Z', counts, rows, truncated: false })!;
const row = (i: number, workState: string, deadline: string) => ({
  jobId: `RQ-FAKE-${i}`, peer: 'dot', kind: 'review', repo: 'ashlrai/phantom', prRefs: [1], state: 'pending',
  workState, deadline, createdAt: '2026-11-15T10:00:00.000Z', attemptedAt: null, receiptSent: null, resultStatus: null, resultAt: null, evidence: 'none' });

it('renders every state; done is peer-reported and VERIFIED never appears', () => {
  const view = mk(STATES.map((s, i) => row(i, s, '2026-11-15T14:00:00.000Z')));
  const { container } = render(<TeammateTasksBody view={view} nowMs={NOW} />);
  expect(screen.getByText('Done (peer-reported, unverified)')).toBeInTheDocument();
  for (const s of ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'CANCELLED']) expect(screen.getByText(s)).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/VERIFIED/);
  expect(screen.queryByRole('button')).toBeNull();
});

it('marks an overdue RUNNING row, but not an overdue finished one', () => {
  render(<TeammateTasksBody view={mk([row(1, 'RUNNING', '2026-11-15T11:00:00.000Z'), row(2, 'REPORTED_DONE', '2026-11-15T11:00:00.000Z')])} nowMs={NOW} />);
  expect(screen.getAllByText(/overdue/)).toHaveLength(1);
});

it('shows the empty message', () => {
  render(<TeammateTasksBody view={mk([])} nowMs={NOW} />);
  expect(screen.getByText('No tasks handed to teammates.')).toBeInTheDocument();
});
