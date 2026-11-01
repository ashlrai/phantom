import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const MIN = 60_000;
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('Leader thread acknowledgment tags', () => {
  it('shows the Inbox seen and waiting labels on Mason entries only', async () => {
    const now = Date.now();
    stubSurfaceFetch({ routes: {
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/leader/thread': { messages: [msg({ id: 'leader', text: 'Leader reply' })] },
      '/api/verse/fleet/runs': { generatedAt: new Date(now).toISOString(), leaders: [{ ageSeconds: 300 }], inbox: [
        { at: etWall(now - 10 * MIN), source: 'Telegram', text: 'Earlier message' },
        { at: etWall(now - 2 * MIN), source: 'Chat', text: 'Later message' },
      ] },
    } });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    const earlier = (await within(log).findByText('Earlier message')).closest('section') as HTMLElement;
    const later = (await within(log).findByText('Later message')).closest('section') as HTMLElement;
    const leader = (await within(log).findByText('Leader reply')).closest('section') as HTMLElement;
    expect(within(earlier).getByText('Seen by a leader pass')).toHaveAttribute('data-ack', 'seen');
    expect(within(later).getByText(/^Waiting · next pass in ~/)).toHaveAttribute('data-ack', 'waiting');
    expect(leader.querySelector('[data-ack]')).toBeNull();
  });

  it('does not show an unknown tag when leader pass data is unavailable', async () => {
    stubSurfaceFetch({ routes: {
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/leader/thread': { messages: [] },
      '/api/verse/fleet/runs': { inbox: [{ at: etWall(Date.now()), source: 'Chat', text: 'No pass data' }] },
    } });
    render(<LeaderThreadPane visible />);
    const line = (await screen.findByText('No pass data')).closest('section') as HTMLElement;
    expect(line.querySelector('[data-ack]')).toBeNull();
  });
});
