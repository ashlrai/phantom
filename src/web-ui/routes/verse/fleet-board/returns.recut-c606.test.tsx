import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ReturnsStrip } from './ReturnsStrip.js';
import { parseReturns, returnsHeadline } from './returns-model.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const envelope = () => ({
  v: 1, authority: 'none', generatedAt: new Date(NOW).toISOString(),
  asOf: new Date(NOW).toISOString(), source: 'coordination-ledger', state: 'known', unparsed: 0,
  returns: [{ claimId: 'fake-c606', repo: 'example/phantom', result: 'BLOCKED',
    evidenceKind: 'dependency', pr: null, head: null, evidence: 'dependency fake-service',
    from: 'fake-agent', at: new Date(NOW + 1_000).toISOString(),
    expiresAt: new Date(NOW + 2_000).toISOString(), temporal: 'future' }],
});

afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('moves a future blocked receipt into and out of current totals without another response', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope())));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => { render(<ReturnsStrip />); });
  expect(screen.getByText('BLOCKED · future (background)')).toHaveAttribute('data-state', 'background');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(screen.getByText('0 current verified, 1 current blocked · 0 background')).toBeInTheDocument();
  expect(screen.getByText('BLOCKED · current')).toHaveAttribute('data-state', 'BLOCKED');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(screen.getByText('0 current verified, 0 current blocked · 1 background')).toBeInTheDocument();
  expect(screen.getByText('BLOCKED · expired (background)')).toHaveAttribute('data-state', 'background');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('recomputes cached receipt age when shown again after expiring while hidden', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(envelope()))));
  const view = await act(async () => render(<ReturnsStrip />));
  view.rerender(<ReturnsStrip visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await act(async () => { view.rerender(<ReturnsStrip visible />); });
  expect(screen.getByText('BLOCKED · expired (background)')).toBeInTheDocument();
});

it('keeps contradictory and legacy qualifications inspectable without a current danger tone', () => {
  const wire = envelope();
  wire.returns[0]!.temporal = 'current';
  const contradictory = parseReturns(wire);
  expect(contradictory.rows[0]?.temporal).toBe('invalid');
  expect(returnsHeadline(contradictory, NOW + 1_000).tone).toBe('neutral');
  const { temporal: _temporal, ...legacy } = wire.returns[0]!;
  const parsed = parseReturns({ ...wire, returns: [legacy] });
  expect(parsed.rows).toHaveLength(1);
  expect(returnsHeadline(parsed, NOW + 1_000)).toEqual({
    text: '0 current verified, 0 current blocked · 1 background', tone: 'neutral',
  });
});
