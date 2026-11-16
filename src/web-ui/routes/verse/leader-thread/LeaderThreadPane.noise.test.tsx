import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

it('renders a quiet status row and a count of hidden commands', async () => {
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/leader/thread': { messages: [] },
    '/api/verse/fleet/runs': { inbox: [
      { at: '2026-11-05T00:00:00Z', source: 'cli', text: '--help' },
      { at: '2026-11-05T00:01:00Z', source: 'Slack', text: 'Phantom status' },
    ] },
  } });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  expect(await within(log).findByText(/You asked for status/)).toHaveTextContent('Slack');
  expect(within(log).queryByText('Phantom status')).toBeNull();
  expect(within(log).getByText('1 stray command line hidden')).toBeInTheDocument();
});
