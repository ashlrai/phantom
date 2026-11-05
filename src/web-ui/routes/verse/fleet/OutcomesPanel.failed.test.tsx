import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { OutcomesPanel } from './OutcomesPanel.js';
import { useSurfaceActions } from '../command/actions.js';
import type { OutcomesRead, OutcomeView } from './outcomes-types.js';

const repo = '/repo/ashlr-hub';
type Task = OutcomeView['tasks'][number];
const task = (n: number, state: Task['state']): Task =>
  ({ id: `task-${n}`, key: `k${n}`, title: `Task title ${n}`, repo, state, runId: state === 'failed' ? `run-${n}` : null,
    controllerRunId: null, proposalId: null, mergeIdentity: null });
function serve(row: OutcomeView) {
  const value: OutcomesRead = { v: 1, sourceState: 'healthy', outcomes: [row], enrollment: { sourceState: 'healthy', repos: [repo] } };
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(value));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function Host() { return <OutcomesPanel actions={useSurfaceActions()} />; }
const base = (status: OutcomeView['status'], tasks: Task[]): OutcomeView => ({
  id: 'outcome-test', revision: 1, scopeRevision: 1, status, tasks,
  scope: { desiredOutcome: 'Continuously improve Phantom', targetRepos: [repo], acceptance: ['Shipped'] },
});
beforeEach(() => { evictAll(); clearMutationToken(); localStorage.clear(); setMutationToken('b'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('failed outcome explanation', () => {
  it('shows which tasks failed and the next step, without a write button', async () => {
    const fetch = serve(base('failed', [task(1, 'failed'), task(2, 'aborted'), task(3, 'complete'), task(4, 'pending'), task(5, 'running')]));
    const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Continuously improve Phantom'));
    expect(screen.getByText('2 of 5 tasks failed')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Failed tasks' });
    expect(list).toHaveTextContent('Task title 1');
    expect(list).toHaveTextContent('Task title 2');
    expect(list).toHaveTextContent('Run run-1');
    expect(screen.getByText('Open the run log to see the error, then retry.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry|resume outcome/i })).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
  it('shows a failed manager stage when no task failed', async () => {
    const row = base('failed', [task(1, 'pending')]);
    row.manager = { sourceState: 'healthy', enabled: true, mode: 'resident', sessionId: null, conversationRevision: 0, running: null, next: null,
      latest: { intent: 'plan', state: 'failed', route: { tier: 'frontier', engine: 'native', seatId: 'seat-1', model: 'm' } } as never };
    serve(row);
    const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Continuously improve Phantom'));
    expect(screen.getAllByText('Manager stage failed').length).toBeGreaterThan(0);
    expect(screen.getByText('Retry planning.')).toBeInTheDocument();
  });
  it('leaves other statuses unchanged', async () => {
    serve(base('running', [task(1, 'failed')]));
    const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Continuously improve Phantom'));
    expect(screen.queryByRole('group', { name: 'Why this outcome failed' })).not.toBeInTheDocument();
  });
});
