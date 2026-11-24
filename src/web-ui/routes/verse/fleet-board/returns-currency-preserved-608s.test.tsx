import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ReturnsStrip } from './ReturnsStrip.js';

// Real ReturnsStrip + cached response: durable receipts survive expiry as background.
const START = Date.parse('2026-11-17T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const row = (pr: number, over: Record<string, unknown> = {}) => ({
  claimId: `fake-608-${pr}`, repo: 'example/phantom', result: 'VERIFIED', evidenceKind: 'pr', pr,
  head: 'abcdef1234567890', evidence: `pr #${pr}`, from: 'fake-agent', at: iso(START),
  expiresAt: iso(START + 5_000), temporal: 'current', ...over,
});
// Row 43 is a legacy receipt with no temporal qualification: it must never count as current.
const { temporal: _omit, ...legacy } = row(43);
const RETURNS = {
  v: 1, authority: 'none', generatedAt: iso(START), source: 'coordination-ledger', asOf: iso(START),
  state: 'known', unparsed: 0, returns: [row(42), legacy],
};
const VERIFY = {
  v: 1, authority: 'none', generatedAt: iso(START), asOf: iso(START), returnsState: 'known',
  coverage: { parsedTotal: 2, omitted: 0, unparsed: 0 }, unparsed: 0, skipped: 0, truncated: false, nonCurrentReceipts: 0,
  checked: [{ claimId: 'fake-608-42', repo: 'example/phantom', pr: 42, head: 'abcdef1234567890',
    verdict: 'closed-unmerged', observedHead: null, mergedAt: null }],
  complete: false,
};
const returnsCalls = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/returns'));

afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps the expired receipt as background at the boundary without refetching, with an independent PR verdict', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(START);
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(JSON.stringify(
    String(url).endsWith('/returns/verify') ? VERIFY : RETURNS))));
  await act(async () => { render(<ReturnsStrip />); });
  expect(screen.getByText('1 current verified, 0 current blocked · 1 background')).toBeInTheDocument();
  expect(screen.getByText('VERIFIED · unknown (background)')).toBeInTheDocument();
  expect(returnsCalls()).toHaveLength(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); // exact expiry, before the 30s poll
  expect(screen.getByText('0 current verified, 0 current blocked · 2 background')).toBeInTheDocument();
  expect(screen.getByText('VERIFIED · expired (background)')).toBeInTheDocument();
  expect(screen.getByText('PR #42 · head abcdef1')).toBeInTheDocument(); // durable row retained
  expect(returnsCalls()).toHaveLength(1);

  // Agent VERIFIED never implies merged: GitHub's separate verdict is shown beside it, not derived from it.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check on GitHub' })); });
  expect(screen.getByText('closed-unmerged')).toBeInTheDocument();
  expect(screen.getByText('not checked')).toBeInTheDocument(); // legacy row 43 has no verdict
  expect(screen.getByText('VERIFIED · expired (background)')).toBeInTheDocument();
});

it('clears the expiry timer when hidden or unmounted', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(START);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(RETURNS))));
  const { rerender, unmount } = render(<ReturnsStrip />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  rerender(<ReturnsStrip visible={false} />);
  expect(vi.getTimerCount()).toBe(0);
  rerender(<ReturnsStrip />);
  // Let the re-show fetch settle so only the strip's own timers remain.
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
