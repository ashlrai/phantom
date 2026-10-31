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

const origins = (log: HTMLElement) => [...log.querySelectorAll('section[data-from]')].map(el => el.getAttribute('data-from'));

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('Leader thread pane merged with the inbox', () => {
  it('renders a Mason inbox line between two leader lines with its source chip', async () => {
    const now = Date.now();
    serve({
      '/api/verse/leader/thread': { messages: [
        msg({ id: 'lead-1', at: new Date(now - 30 * MIN).toISOString(), text: 'Merges are green tonight.' }),
        msg({ id: 'lead-2', at: new Date(now - 10 * MIN).toISOString(), text: 'I will watch the judge queue.' }),
      ] },
      '/api/verse/fleet/runs': { inbox: [
        { at: etWall(now - 20 * MIN), source: 'Telegram', text: 'Ship the judge fix first.' },
        { at: etWall(now - 5 * MIN), source: 'Phantom desktop', text: 'And then re-check the queue.' },
      ] },
    });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('Ship the judge fix first.')).toBeInTheDocument();
    expect(await within(log).findByText('Merges are green tonight.')).toBeInTheDocument();
    expect(await within(log).findByText('I will watch the judge queue.')).toBeInTheDocument();
    expect(origins(log)).toEqual(['leader', 'mason', 'leader', 'mason']);
    const masonLines = [...log.querySelectorAll('section[data-from="mason"]')];
    expect(within(masonLines[0] as HTMLElement).getByText('You')).toBeInTheDocument();
    expect(within(masonLines[0] as HTMLElement).getByText('Telegram')).toBeInTheDocument();
    expect(within(masonLines[1] as HTMLElement).getByText('Phantom desktop')).toBeInTheDocument();
  });

  it('still shows inbox lines when the thread route is absent', async () => {
    const now = Date.now();
    serve({
      '/api/verse/leader/thread': null,
      '/api/verse/fleet/runs': { inbox: [
        { at: etWall(now - 5 * MIN), source: 'Phantom desktop', text: 'Check the merge queue.' },
      ] },
    });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('Check the merge queue.')).toBeInTheDocument();
    expect(origins(log)).toEqual(['mason']);
    expect(screen.getByText(/The Leader conversation is not in this build yet/)).toBeInTheDocument();
  });

  it('says so when neither the thread nor the inbox has anything', async () => {
    serve({
      '/api/verse/leader/thread': { messages: [] },
      '/api/verse/fleet/runs': { inbox: [] },
    });
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText(/No conversation or interjections yet/)).toBeInTheDocument();
  });
});
