import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { projectCoordinationReturns } from '../../../../core/fleet/coordination-returns-view.js';
import { evictAll } from '../../../data/cache.js';
import { ReturnsBody, ReturnsStrip } from './ReturnsStrip.js';
import { parseReturns, returnsHeadline } from './returns-model.js';

const AT = Date.parse('2026-11-17T12:00:00.000Z');
const EXPIRY = AT + 60_000;
function envelope(now = AT) {
  return JSON.parse(JSON.stringify({
    ...projectCoordinationReturns({
      schema: 'fleet.coordination.v1', state: 'known', claims: [], proposals: [], expiredClaims: 0,
      messages: [{ id: 'return-fake-540s', from: 'fake-agent', to: '*', at: AT, expiresAt: EXPIRY,
        body: 'RESULT VERIFIED example/phantom claim fake-540s task "fake task": pr #42 head abcdef1234567890' }],
    }, now), authority: 'none', generatedAt: new Date(now).toISOString(),
  }));
}
afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders the serialized real projection, then expires the same parsed receipt at the exact boundary', () => {
  vi.useFakeTimers(); vi.setSystemTime(EXPIRY - 1);
  const wire = envelope();
  expect(wire.returns[0].temporal).toBe('current');
  const parsed = parseReturns(wire);
  const { rerender } = render(<ReturnsBody parsed={parsed} now={Date.now()} />);
  expect(screen.getByText('1 current verified, 0 current blocked · 0 background')).toBeInTheDocument();
  expect(screen.getByText('VERIFIED · current')).toBeInTheDocument();
  expect(screen.getByText('PR #42 · head abcdef1')).toBeInTheDocument();
  vi.setSystemTime(EXPIRY);
  rerender(<ReturnsBody parsed={parsed} now={Date.now()} />);
  expect(screen.getByText('VERIFIED · expired (background)')).toBeInTheDocument();
  expect(returnsHeadline(parsed, Date.now()).tone).toBe('neutral');
  expect(screen.getByText("VERIFIED is the returning agent's evidence; Phantom has not checked the PR.")).toBeInTheDocument();
});

it.each(['expired', 'future', 'invalid', 'missing', 'malformed', 'contradictory'])(
  'keeps %s evidence inspectable without current success', kind => {
    vi.useFakeTimers(); vi.setSystemTime(AT);
    const wire = envelope(kind === 'expired' ? EXPIRY : kind === 'future' ? AT - 1 : AT);
    const row = wire.returns[0];
    if (kind === 'invalid') { row.expiresAt = row.at; row.temporal = 'invalid'; }
    if (kind === 'missing') delete row.temporal;
    if (kind === 'malformed') row.temporal = { current: true };
    if (kind === 'contradictory') row.expiresAt = new Date(AT - 1).toISOString();
    if (kind === 'expired') vi.setSystemTime(EXPIRY);
    if (kind === 'future') vi.setSystemTime(AT - 1);
    const parsed = parseReturns(wire);
    render(<ReturnsBody parsed={parsed} now={Date.now()} />);
    expect(screen.getByText('0 current verified, 0 current blocked · 1 background')).toBeInTheDocument();
    expect(screen.getByText(/VERIFIED · .*\(background\)/)).toBeInTheDocument();
    expect(screen.getByText('PR #42 · head abcdef1')).toBeInTheDocument();
    expect(returnsHeadline(parsed, Date.now()).tone).toBe('neutral');
  },
);

it.each([{ state: 'unknown' }, { v: 2 }])('suppresses current claims in unknown envelopes: %j', over => {
  vi.useFakeTimers(); vi.setSystemTime(AT);
  render(<ReturnsBody parsed={parseReturns({ ...envelope(), ...over })} now={Date.now()} />);
  expect(screen.getByText(/Results unknown:/)).toBeInTheDocument();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});

it('expires loaded strip data without waiting for another network response', async () => {
  vi.useFakeTimers(); vi.setSystemTime(EXPIRY - 1);
  const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope())));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => { render(<ReturnsStrip />); });
  expect(screen.getByText('VERIFIED · current')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText('VERIFIED · expired (background)')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
