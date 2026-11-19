import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

vi.mock('../dock/dock-store.js', async original => ({ ...(await original<typeof import('../dock/dock-store.js')>()), openDockPane: vi.fn() }));

const MIN = 60_000;
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

function stub(runs: unknown) {
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/leader/thread': { messages: [msg({ id: 'leader', text: 'Leader reply' })] },
    '/api/verse/fleet/runs': runs,
  } });
}
const presence = () => screen.getByRole('region', { name: 'Leader presence' });

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); clearMutationToken(); });

describe('Leader presence under the reply box', () => {
  it('says when the Leader last read and how many messages wait for the next pass', async () => {
    const now = Date.now();
    stub({ generatedAt: new Date(now).toISOString(), leaders: [{ label: 'plan', ageSeconds: 300 }], inbox: [
      { at: etWall(now - 10 * MIN), source: 'Telegram', text: 'Earlier message' },
      { at: etWall(now - 2 * MIN), source: 'Chat', text: 'Later message' },
    ] });
    render(<LeaderThreadPane visible />);
    expect(await within(presence()).findByText(/^Last leader pass 5 min ago · next in about 10 min$/)).toBeInTheDocument();
    expect(presence()).toHaveAttribute('data-state', 'due');
    expect(within(presence()).getByText('1 message of yours waits for the next pass.')).toHaveAttribute('data-waiting', 'true');
    expect(within(presence()).queryByRole('button')).toBeNull();
    // The reply box comes first: presence is the line under it.
    const box = screen.getByRole('textbox', { name: 'Reply to the Leader' });
    expect(box.compareDocumentPosition(presence()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('turns to a stalled warning with a way into the journal when passes have stopped', async () => {
    const now = Date.now();
    stub({ generatedAt: new Date(now).toISOString(), leaders: [{ label: 'plan', ageSeconds: 52 * 60 }], inbox: [
      { at: etWall(now - 4 * MIN), source: 'Chat', text: 'Is anyone there' },
    ] });
    render(<LeaderThreadPane visible />);
    expect(await within(presence()).findByText('No leader pass for 52 min')).toBeInTheDocument();
    expect(presence()).toHaveAttribute('data-state', 'stalled');
    expect(within(presence()).getByText('1 message of yours is unread until a pass runs.')).toBeInTheDocument();
    fireEvent.click(within(presence()).getByRole('button', { name: 'Open the journal' }));
    expect(openDockPane).toHaveBeenCalledWith('leader-journal');
  });

  it('reads unknown, with no count and no bar, when the fleet read holds no pass', async () => {
    stub({ inbox: [{ at: etWall(Date.now()), source: 'Chat', text: 'No pass data' }] });
    render(<LeaderThreadPane visible />);
    expect(await within(presence()).findByText('Leader pass time unknown')).toBeInTheDocument();
    expect(presence()).toHaveAttribute('data-state', 'unknown');
    expect(within(presence()).getByText('No leader pass is recorded in the fleet read.')).toBeInTheDocument();
    expect(within(presence()).queryByText(/of your|Everything you sent/)).toBeNull();
    expect(presence().querySelector('[style]')).toBeNull();
  });

  it('reads unknown when the fleet read fails', async () => {
    stub(() => new Response('nope', { status: 500 }));
    render(<LeaderThreadPane visible />);
    expect(await within(presence()).findByText('Leader pass time unknown')).toBeInTheDocument();
    expect(within(presence()).getByText(/The fleet read did not answer/)).toBeInTheDocument();
  });
});
