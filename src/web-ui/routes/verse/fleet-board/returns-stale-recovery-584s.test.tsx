import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ReturnsStrip } from './ReturnsStrip.js';
import { parseReturns, returnsHeadline } from './returns-model.js';

const start = Date.parse('2026-11-17T12:00:00.000Z');
const envelope = (at: number, expiresAt: number) => ({
  v: 1, authority: 'none', generatedAt: new Date(at).toISOString(), source: 'coordination-ledger',
  asOf: new Date(at).toISOString(), state: 'known', unparsed: 0,
  returns: [{ claimId: 'synthetic', repo: 'example/phantom', result: 'VERIFIED', evidenceKind: 'pr',
    pr: 42, head: 'abcdef1234567890', evidence: 'pr #42', from: 'agent',
    at: new Date(at).toISOString(), expiresAt: new Date(expiresAt).toISOString(), temporal: 'current' }],
});

afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('ages a receipt out without a response and accepts a fresh qualified response', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const first = envelope(start, start + 1_000);
  const fresh = envelope(start + 30_000, start + 60_000);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(first)))
    .mockResolvedValueOnce(new Response(JSON.stringify(fresh)));
  vi.stubGlobal('fetch', fetcher);
  const parsed = parseReturns(first);
  expect(returnsHeadline(parsed, start).tone).toBe('success');
  await act(async () => { render(<ReturnsStrip />); });
  expect(screen.getByText('VERIFIED · current')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(returnsHeadline(parsed, Date.now()).tone).toBe('neutral');
  expect(screen.getByText('VERIFIED · expired (background)')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(returnsHeadline(parseReturns(fresh), Date.now()).tone).toBe('success');
  expect(screen.getByText('VERIFIED · current')).toBeInTheDocument();
});
