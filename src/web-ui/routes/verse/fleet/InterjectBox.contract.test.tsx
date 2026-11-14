import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';

const AT_JOB = '2026-11-01 00:08 ET';
const AT_NONE = '2026-11-01 00:09 ET';

beforeEach(() => {
  sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/verse/leader/orders')) {
      return Response.json({
        v: 1, generatedAt: '2026-11-01T05:00:00Z', sources: { inbox: null, prompts: null, publishes: null },
        orders: [{ at: AT_JOB, source: 'Phantom desktop', key: '11-01 00:08', jobs: [
          { id: 'RQ-PHX-FAKE01', lane: 'claude', state: 'launched', url: null }] }],
      });
    }
    return Response.json({ inbox: [
      { at: AT_JOB, source: 'Phantom desktop', text: 'With job' },
      { at: AT_NONE, source: 'Phantom desktop', text: 'No job' }] });
  }));
});
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('leads each outcome line with the contract state and shows missing evidence', async () => {
  const { container } = render(<InterjectBox />);
  const assigned = await vi.waitFor(() => {
    const el = container.querySelector('[data-contract="ASSIGNED"]');
    expect(el).not.toBeNull();
    return el!;
  });
  expect(assigned.textContent?.startsWith('ASSIGNED ·')).toBe(true);
  expect(assigned.textContent).toContain('job RQ-PHX-FAKE01 running');
  expect(assigned).not.toHaveAttribute('title');
  const received = container.querySelector('[data-contract="RECEIVED"]')!;
  expect(received.textContent?.startsWith('RECEIVED ·')).toBe(true);
  expect(received).toHaveAttribute('title', 'missing: named owner, durable claim receipt');
  expect(screen.getAllByText(/^(ASSIGNED|RECEIVED) ·/)).toHaveLength(2);
});
