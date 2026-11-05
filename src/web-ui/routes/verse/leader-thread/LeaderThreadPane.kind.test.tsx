import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

it('shows kinds and filters to items needing Mason', async () => {
  const now = Date.now();
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/leader/thread': { messages: [] },
    '/api/verse/fleet/runs': { generatedAt: new Date(now).toISOString(), leaders: [{ ageSeconds: 300 }],
      inbox: [{ at: etWall(now - 60_000), source: 'Chat', text: 'Waiting message' }],
      outbox: [
        { at: '', text: 'Please approve the plan' },
        { at: '', text: 'The change shipped' },
        { at: '', text: 'The report is ready' },
      ],
    },
  } });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  for (const [text, label] of [['Please approve the plan', 'Needs you'], ['The change shipped', 'Done'], ['The report is ready', 'FYI']]) {
    const line = (await within(log).findByText(text!)).closest('section') as HTMLElement;
    expect(within(line).getByText(label!)).toBeInTheDocument();
  }
  const toggle = screen.getByRole('button', { name: 'Needs you only' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(within(log).getByText('Please approve the plan')).toBeInTheDocument();
  expect(within(log).getByText('Waiting message')).toBeInTheDocument();
  expect(within(log).queryByText('The change shipped')).toBeNull();
  expect(within(log).queryByText('The report is ready')).toBeNull();
  fireEvent.click(toggle);
  expect(within(log).getByText('The change shipped')).toBeInTheDocument();
  expect(within(log).getByText('The report is ready')).toBeInTheDocument();
});
