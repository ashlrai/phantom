import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

/** The wall-clock string MASON-INBOX.md writes ("YYYY-MM-DD HH:MM" in America/New_York). */
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

const MIN = 60_000;

function serve(routes: NonNullable<Parameters<typeof stubSurfaceFetch>[0]>['routes']) {
  return stubSurfaceFetch({ routes: { '/api/verse/leader/directives': { directives: [] }, ...routes } });
}

const sources = (log: HTMLElement) => [...log.querySelectorAll('section[data-source]')].map(el => el.getAttribute('data-source'));

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('Leader thread pane with MASON-OUTBOX answers', () => {
  it('renders an outbox answer between Mason’s inbox lines with its chip', async () => {
    const now = Date.now();
    serve({
      '/api/verse/leader/thread': { messages: [
        msg({ id: 'lead-1', at: new Date(now - 30 * MIN).toISOString(), text: 'Working on it now.' }),
      ] },
      '/api/verse/fleet/runs': {
        inbox: [
          { at: etWall(now - 20 * MIN), source: 'Telegram', text: 'Why is the judge queue stuck?' },
          { at: etWall(now - 2 * MIN), source: 'Phantom desktop', text: 'Thanks.' },
        ],
        outbox: [
          { at: new Date(now - 10 * MIN).toISOString(), text: 'The judge queue was starved; I raised grok-a to 3 lanes.' },
        ],
      },
    });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('Why is the judge queue stuck?')).toBeInTheDocument();
    expect(await within(log).findByText('The judge queue was starved; I raised grok-a to 3 lanes.')).toBeInTheDocument();
    expect(sources(log)).toEqual(['verse', 'Telegram', 'outbox', 'Phantom desktop']);
    const outboxLine = log.querySelector('section[data-source="outbox"]') as HTMLElement;
    expect(outboxLine.getAttribute('data-from')).toBe('leader');
    expect(within(outboxLine).getByText('Leader outbox')).toBeInTheDocument();
  });

  it('keeps the conversation unchanged when the runs read has no outbox', async () => {
    const now = Date.now();
    serve({
      '/api/verse/leader/thread': { messages: [
        msg({ id: 'lead-1', at: new Date(now - 10 * MIN).toISOString(), text: 'All green.' }),
      ] },
      '/api/verse/fleet/runs': { inbox: [{ at: etWall(now - 5 * MIN), source: 'Phantom desktop', text: 'Status?' }] },
    });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('All green.')).toBeInTheDocument();
    expect(log.querySelector('section[data-source="outbox"]')).toBeNull();
  });
});
