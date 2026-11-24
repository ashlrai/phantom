import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { leaderHealthQuery } from './leader-health-model.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

vi.mock('../dock/dock-store.js', async original => ({ ...(await original<typeof import('../dock/dock-store.js')>()), openDockPane: vi.fn() }));

const HEALTH = '/api/verse/leader/health';
const doc = (over: Record<string, unknown> = {}) => ({
  schema: 'fleet.leader-health.v1', source: 'read', consecutiveFailures: 3, hoursSinceLastSuccess: 4.2,
  lastBetAt: null, cause: 'Claude sign-in expired: run claude login', ...over,
});

function stub(health: unknown) {
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/leader/thread': { messages: [msg({ id: 'leader', text: 'Leader reply' })] },
    '/api/verse/fleet/runs': { generatedAt: new Date().toISOString(), leaders: [{ label: 'plan', ageSeconds: 300 }], inbox: [] },
    [HEALTH]: health,
  } });
}
const healthCalls = (handle: ReturnType<typeof stub>) => handle.fetchMock.mock.calls.filter(call => String(call[0]).split('?')[0] === HEALTH).length;
const box = () => screen.getByRole('textbox', { name: 'Reply to the Leader' });

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); clearMutationToken(); });

describe('Leader health above the reply box', () => {
  it('says the Leader is not reading, why, and what to run, just above where Mason writes', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    stub(doc());
    render(<LeaderThreadPane visible />);
    const notice = await screen.findByRole('alert', { name: 'Leader health' });
    expect(notice).toHaveAttribute('data-state', 'down');
    expect(within(notice).getByText('The Leader’s last 3 passes failed.')).toBeInTheDocument();
    expect(within(notice).getByText('Last good pass 4 h ago.')).toBeInTheDocument();
    expect(within(notice).getByText('It is not reading you. What you send is kept in its inbox until a pass succeeds.')).toBeInTheDocument();
    expect(within(notice).getByText('Claude sign-in expired: run claude login')).toBeInTheDocument();
    expect(within(notice).getByText('phm fleet leader-health')).toBeInTheDocument();
    expect(notice.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(notice).getByRole('button', { name: 'Copy the command claude login' }));
    expect(await within(notice).findByText('Copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('claude login');
    fireEvent.click(within(notice).getByRole('button', { name: 'Open the journal' }));
    expect(openDockPane).toHaveBeenCalledWith('leader-journal');
  });

  it('warns after one failed pass, says the cause is unknown when none was read, and offers no command', async () => {
    stub(doc({ consecutiveFailures: 1, hoursSinceLastSuccess: 0.5, cause: null }));
    render(<LeaderThreadPane visible />);
    const notice = await screen.findByRole('status', { name: 'Leader health' });
    expect(notice).toHaveAttribute('data-state', 'failed');
    expect(within(notice).getByText('The Leader’s last pass failed.')).toBeInTheDocument();
    expect(within(notice).getByText('Last good pass 30 min ago.')).toBeInTheDocument();
    expect(within(notice).getByText('unknown: the failing pass left no output to read')).toBeInTheDocument();
    expect(within(notice).queryByRole('button', { name: /^Copy/ })).toBeNull();
  });

  it.each([
    ['a healthy Leader', doc({ consecutiveFailures: 0, hoursSinceLastSuccess: 0.1, cause: null })],
    ['a log with no pass in it', doc({ source: 'unknown', consecutiveFailures: null, hoursSinceLastSuccess: null, cause: null })],
    ['a body of another shape', { leader: 'fine' }],
    ['a server without the read', null],
    ['a read that fails', () => new Response('nope', { status: 503 })],
  ])('draws nothing for %s', async (_name, health) => {
    const handle = stub(health);
    render(<LeaderThreadPane visible />);
    await screen.findByRole('region', { name: 'Leader presence' });
    await waitFor(() => expect(healthCalls(handle)).toBeGreaterThan(0));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByLabelText('Leader health')).toBeNull();
  });

  it('reads again on Check again, then says the Leader is passing again until dismissed', async () => {
    let failures = 2;
    const handle = stub(() => new Response(JSON.stringify(doc({ consecutiveFailures: failures, hoursSinceLastSuccess: failures ? 6 : 0.05, cause: failures ? 'spawn ENOENT' : null })),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(<LeaderThreadPane visible />);
    const down = await screen.findByRole('alert', { name: 'Leader health' });
    expect(within(down).getByText('The Leader’s last 2 passes failed.')).toBeInTheDocument();
    expect(within(down).getByText('spawn ENOENT')).toBeInTheDocument();
    expect(within(down).queryByRole('button', { name: /^Copy/ })).toBeNull();

    failures = 0;
    const before = healthCalls(handle);
    fireEvent.click(within(down).getByRole('button', { name: 'Check again' }));
    const back = await screen.findByRole('status', { name: 'Leader health' });
    expect(healthCalls(handle)).toBe(before + 1);
    expect(back).toHaveAttribute('data-state', 'recovered');
    expect(within(back).getByText('The Leader is passing again.')).toBeInTheDocument();
    expect(within(back).getByText('Last good pass 3 min ago.')).toBeInTheDocument();
    expect(within(back).queryByText(/Cause/)).toBeNull();
    fireEvent.click(within(back).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByLabelText('Leader health')).toBeNull();
  });

  it('keeps the last reading and says it may be out of date when a refresh fails', async () => {
    let fail = false;
    stub(() => (fail ? new Response('nope', { status: 503 }) : new Response(JSON.stringify(doc()), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(<LeaderThreadPane visible />);
    const notice = await screen.findByRole('alert', { name: 'Leader health' });
    expect(within(notice).queryByText(/out of date/)).toBeNull();
    fail = true;
    await act(async () => { await refetchQuery(leaderHealthQuery.key, () => leaderHealthQuery.fetch()); });
    expect(within(notice).getByText('This reading could not be refreshed, so it may be out of date.')).toBeInTheDocument();
    expect(within(notice).getByText('The Leader’s last 3 passes failed.')).toBeInTheDocument();
  });
});
