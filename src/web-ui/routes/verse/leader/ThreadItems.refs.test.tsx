import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { ThreadRows, type ThreadContext } from './ThreadItems.js';
import { msg } from './thread-fixtures.test-support.js';
import { groupThread, type ThreadEntry } from './thread-model.js';
import type { LeaderThreadMessage } from './thread-types.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));
vi.mock('../dock/dock-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn(),
}));
afterEach(cleanup);

const ctx: ThreadContext = {
  leader: null,
  actions: { act: vi.fn(), busy: false, error: null, clearError: vi.fn(), readOnly: false, dialogs: null },
  answered: new Map(), byId: new Map(), answering: new Set(), focusQuestionId: null,
  answerDraft: () => '', setAnswerDraft: vi.fn(), onAnswer: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(),
  sendDisabledReason: null, dormant: false,
};
function show(message: LeaderThreadMessage) {
  const entry: ThreadEntry = { type: 'message', key: message.id, at: message.at, message };
  return render(<ThreadRows rows={groupThread([entry])} ctx={ctx} />);
}
const text = 'See RQ-PHX-EXAMPLE01 and #2495.';

it('opens a memo job in the worker log and links its PR', () => {
  show(msg({ id: 'memo', kind: 'memo', text }));
  const row = screen.getByLabelText('Referenced jobs and PRs');
  expect(within(row).getByRole('link', { name: '#2495' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/2495');
  fireEvent.click(within(row).getByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE01' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-EXAMPLE01');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  expect(vi.mocked(requestWorkerLogJob).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openDockPane).mock.invocationCallOrder[0]!);
});

it.each(['message', 'update', 'action', 'question'] as const)('shows refs for a leader %s', kind => {
  show(msg({ id: kind, kind, text }));
  expect(within(screen.getByLabelText('Referenced jobs and PRs')).getByRole('button', { name: /RQ-PHX-EXAMPLE01/ })).toBeInTheDocument();
});

it('does not show a refs row for Mason', () => {
  show(msg({ id: 'mason', from: 'mason', text }));
  expect(screen.queryByLabelText('Referenced jobs and PRs')).not.toBeInTheDocument();
});

it('does not add a refs row to a message without references', () => {
  show(msg({ id: 'plain', text: 'A plain sentence.' }));
  expect(screen.queryByLabelText('Referenced jobs and PRs')).not.toBeInTheDocument();
  expect(screen.getByText('A plain sentence.')).toBeInTheDocument();
});
