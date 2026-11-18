import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';

const AT = '2026-11-01 00:08 ET';

function stub(ordersStatus: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/api/verse/fleet/work-board/orders')) {
      if (ordersStatus !== 200) return new Response('no', { status: ordersStatus });
      return Response.json({ v: 1, asOf: '2026-11-01T05:00:00Z', sources: 'unavailable', orders: [{
        at: AT, source: 'Phantom desktop', key: '11-01 00:08', state: 'BLOCKED', asOf: '2026-11-01T05:00:00Z',
        evidenceSource: 'test', missing: [], pr: null, owner: null, blocker: 'devin' }] });
    }
    if (u.includes('/api/verse/leader/orders')) {
      return Response.json({ v: 1, generatedAt: '2026-11-01T05:00:00Z', sources: { inbox: null, prompts: null, publishes: null },
        orders: [{ at: AT, source: 'Phantom desktop', key: '11-01 00:08', jobs: [{ id: 'RQ-PHX-FAKE01', lane: 'claude', state: 'launched', url: null }] }] });
    }
    return Response.json({ inbox: [{ at: AT, source: 'Phantom desktop', text: 'Order' }] });
  }));
}

beforeEach(() => { sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('shows the server BLOCKED verdict and blocker', async () => {
  stub(200);
  const { container } = render(<InterjectBox />);
  const el = await vi.waitFor(() => {
    const found = container.querySelector('[data-contract="BLOCKED"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(el).toHaveAttribute('data-contract-source', 'server');
  expect(el.textContent).toContain('waiting on: devin');
});

it('falls back to the local contract when the orders route is 404', async () => {
  stub(404);
  const { container } = render(<InterjectBox />);
  const el = await vi.waitFor(() => {
    const found = container.querySelector('[data-contract="ASSIGNED"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(el).toHaveAttribute('data-contract-source', 'local');
  expect(el.textContent).not.toContain('waiting on');
});
