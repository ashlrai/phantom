import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';

const AT = '2026-11-01 00:08 ET';

beforeEach(() => {
  sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/verse/leader/orders')) {
      return Response.json({
        v: 1, generatedAt: '2026-11-01T05:00:00Z', sources: { inbox: null, prompts: null, publishes: null },
        orders: [{ at: AT, source: 'Phantom desktop', key: '11-01 00:08', jobs: [
          { id: 'RQ-PHX-FAKE01', lane: null, state: 'launched', url: null },
          { id: 'RQ-PHX-FAKE02', lane: null, state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/1234' }] }],
      });
    }
    return Response.json({ inbox: [{ at: AT, source: 'Phantom desktop', text: 'Ship it' }] });
  }));
});
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('shows "merged #1234" with a PR link once the trace resolves', async () => {
  render(<InterjectBox />);
  const link = await screen.findByRole('link', { name: 'merged #1234' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1234');
});
