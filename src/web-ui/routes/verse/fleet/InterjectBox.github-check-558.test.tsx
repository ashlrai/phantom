import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';

const AT = '2026-11-01 00:08 ET';

function stub(github: 'merged' | 'open' | 'fail') {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/api/verse/fleet/control/interject-pr-check')) {
      if (github === 'fail') return new Response('no', { status: 500 });
      return Response.json({ v: 1, authority: 'none', generatedAt: '2026-11-01T05:00:00Z', items: [{
        pr: 777, verdict: github, mergedAt: github === 'merged' ? '2026-11-01T04:00:00Z' : null }] });
    }
    if (u.includes('/api/verse/fleet/work-board/orders')) return new Response('no', { status: 404 });
    if (u.includes('/api/verse/leader/orders')) {
      return Response.json({ v: 1, generatedAt: '2026-11-01T05:00:00Z', sources: { inbox: null, prompts: null, publishes: null },
        orders: [{ at: AT, source: 'Phantom desktop', key: '11-01 00:08', jobs: [{ id: 'RQ-PHX-FAKE01', lane: 'claude', state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/777' }] }] });
    }
    return Response.json({ inbox: [{ at: AT, source: 'Phantom desktop', text: 'Order' }] });
  }));
}

beforeEach(() => { sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

async function row(container: HTMLElement, github: string) {
  return vi.waitFor(() => {
    const found = container.querySelector(`[data-outcome="merged"][data-github="${github}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
}

it('shows GitHub: merged when GitHub agrees', async () => {
  stub('merged');
  const { container } = render(<InterjectBox />);
  const el = await row(container, 'merged');
  expect(el.textContent).toContain('GitHub: merged');
  expect(el.textContent).toContain('merged #777');
});

it('shows unconfirmed, not VERIFIED, when GitHub says open', async () => {
  stub('open');
  const { container } = render(<InterjectBox />);
  const el = await row(container, 'open');
  expect(el.textContent).toContain('GitHub: still open');
  expect(el.textContent).toContain('unconfirmed');
  expect(el.textContent).not.toContain('VERIFIED');
  expect(el.getAttribute('data-contract')).toBe('VERIFIED');
});

it('shows GitHub: unknown and keeps the row when the read fails', async () => {
  stub('fail');
  const { container } = render(<InterjectBox />);
  const el = await row(container, 'unknown');
  expect(el.textContent).toContain('GitHub: unknown');
  expect(el.textContent).toContain('merged #777');
  expect(el.textContent).toContain('VERIFIED');
});
