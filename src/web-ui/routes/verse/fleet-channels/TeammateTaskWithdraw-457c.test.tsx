import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { narrowTeammateTasks } from './teammate-tasks-model.js';
import { TeammateTasksBody } from './TeammateTasksCard.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const NOW = Date.parse('2026-11-15T12:00:00Z');
const counts = { queued: 0, sending: 0, pending: 3, replied: 0, expired: 0, cancelled: 0 };
const row = (i: number, workState: string) => ({
  jobId: `RQ-FAKE-${i}`, peer: 'dot', kind: 'review', repo: 'example/repo', prRefs: [1], state: 'pending',
  workState, deadline: '2026-11-15T14:00:00.000Z', createdAt: '2026-11-15T10:00:00.000Z', attemptedAt: null, receiptSent: null, resultStatus: null, resultAt: null, evidence: 'none' });
const view = () => narrowTeammateTasks({ schema: 'imessage.teammate-tasks.v1', asOf: '2026-11-15T12:00:00.000Z', counts, rows: [row(1, 'ASSIGNED'), row(2, 'RUNNING'), row(3, 'CANCELLED')], truncated: false })!;

it('only the ASSIGNED row has a Withdraw button', () => {
  render(<TeammateTasksBody view={view()} nowMs={NOW} onWithdraw={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
});
it('confirms, then shows core\'s refusal reason word for word', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const onWithdraw = vi.fn(async () => ({ state: 'refused', reason: 'Task was already attempted' }));
  render(<TeammateTasksBody view={view()} nowMs={NOW} onWithdraw={onWithdraw} />);
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
  expect(confirm).toHaveBeenCalledWith('Withdraw unsent task RQ-FAKE-1? This only cancels the local reservation.');
  expect(await screen.findByText('Refused: Task was already attempted')).toBeInTheDocument();
  expect(onWithdraw).toHaveBeenCalledWith('RQ-FAKE-1');
});
it('shows Withdrawn for cancelled and disables the button while in flight', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  let done!: (v: { state: string }) => void;
  const onWithdraw = vi.fn(() => new Promise<{ state: string }>((r) => { done = r; }));
  render(<TeammateTasksBody view={view()} nowMs={NOW} onWithdraw={onWithdraw} />);
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled());
  done({ state: 'cancelled' });
  expect(await screen.findByText('Withdrawn')).toBeInTheDocument();
});
it('does nothing when the confirm is declined', () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const onWithdraw = vi.fn();
  render(<TeammateTasksBody view={view()} nowMs={NOW} onWithdraw={onWithdraw} />);
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
  expect(onWithdraw).not.toHaveBeenCalled();
});
