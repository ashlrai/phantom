import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowClaimNotices } from './claim-notices-model.js';
import { ClaimNoticesBody } from './ClaimNoticesCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-18T12:00:00Z');
const GENERATED = '2026-11-18T11:58:00.000Z';
const THREAD = 'T00000000/C00000000/1700000000.000100';
const pendingRows = [
  { state: 'VERIFIED', threadKey: THREAD, text: 'first notice body' },
  { state: 'RELEASED', threadKey: THREAD, text: 'second notice body' }];
const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, source: 'ok', bindings: 1,
  sent: { total: 0, recent: [] }, pending: [], slackConfigured: true,
  generatedAt: GENERATED, pendingObservation: { state: 'known' }, ...over });
const view = (over?: Record<string, unknown>) => narrowClaimNotices(raw(over))!;
const withoutKey = (key: string) => { const r = raw(); delete r[key]; return r; };

describe('narrowClaimNotices asOf and pendingObservation', () => {
  it('keeps a parseable generatedAt and rejects malformed or non-string values', () => {
    expect(view().asOf).toBe(GENERATED);
    expect(view({ generatedAt: 'not a date' }).asOf).toBeNull();
    expect(view({ generatedAt: 1700000000000 }).asOf).toBeNull();
    expect(narrowClaimNotices(withoutKey('generatedAt'))!.asOf).toBeNull();
  });

  it('is known only on an explicit known state', () => {
    expect(view().pendingObservation).toEqual({ state: 'known' });
    for (const bad of [null, 'known', true, { state: 'Known' }, { state: 'maybe' }, [], {}]) {
      expect(view({ pendingObservation: bad }).pendingObservation.state).toBe('unknown');
    }
  });

  it('keeps the six server reasons and maps anything else to not-reported', () => {
    for (const reason of ['state-missing', 'ledger-unavailable', 'board-unavailable',
      'bindings-unavailable', 'prev-unavailable', 'observation-failed']) {
      expect(view({ pendingObservation: { state: 'unknown', reason } }).pendingObservation).toEqual({ state: 'unknown', reason });
    }
    expect(view({ pendingObservation: { state: 'unknown', reason: 'disk on fire' } }).pendingObservation)
      .toEqual({ state: 'unknown', reason: 'not-reported' });
    expect(narrowClaimNotices(withoutKey('pendingObservation'))!.pendingObservation)
      .toEqual({ state: 'unknown', reason: 'not-reported' });
  });

  it('never upgrades unknown to known, even when pending rows are present', () => {
    const v = view({ pending: pendingRows, pendingObservation: { state: 'unknown', reason: 'ledger-unavailable' } });
    expect(v.pendingObservation.state).toBe('unknown');
  });
});

describe('ClaimNoticesBody as-of and pending observation', () => {
  it('shows "2 waiting" and both rows when the observation is known', () => {
    render(<ClaimNoticesBody view={view({ pending: pendingRows })} nowMs={NOW} />);
    expect(screen.getByText(/· 2 waiting/)).toBeInTheDocument();
    expect(screen.getByText('first notice body')).toBeInTheDocument();
    expect(screen.getByText('second notice body')).toBeInTheDocument();
    expect(screen.getAllByText('would post')).toHaveLength(2);
  });

  it('says pending unknown (board-unavailable) and never "0 waiting"', () => {
    const v = view({ pendingObservation: { state: 'unknown', reason: 'board-unavailable' } });
    const { container } = render(<ClaimNoticesBody view={v} nowMs={NOW} />);
    expect(screen.getByText(/pending unknown \(board-unavailable\)/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d+ waiting/);
  });

  it('reads a payload with no pendingObservation (old server) as pending unknown (not-reported)', () => {
    const { container } = render(<ClaimNoticesBody view={narrowClaimNotices(withoutKey('pendingObservation'))!} nowMs={NOW} />);
    expect(screen.getByText(/pending unknown \(not-reported\)/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d+ waiting/);
  });

  it('renders an as-of time element for a valid generatedAt, for every source', () => {
    for (const source of ['ok', 'missing', 'unreadable']) {
      const { container } = render(<ClaimNoticesBody view={view({ source })} nowMs={NOW} />);
      const t = container.querySelector('time[datetime="' + GENERATED + '"]');
      expect(t).not.toBeNull();
      expect(t!.textContent).toBe('2m ago');
      expect(container.textContent).toContain('as of 2m ago');
      cleanup();
    }
  });

  it('says "as of unknown" for a malformed or missing generatedAt', () => {
    render(<ClaimNoticesBody view={view({ generatedAt: 'garbage' })} nowMs={NOW} />);
    expect(screen.getByText('as of unknown')).toBeInTheDocument();
    cleanup();
    const { container } = render(<ClaimNoticesBody view={view({ generatedAt: 'garbage', source: 'missing' })} nowMs={NOW} />);
    expect(container.textContent).toContain('as of unknown');
    expect(container.querySelector('time')).toBeNull();
  });

  it('renders no "would post" row when the observation is unknown, even with pending rows', () => {
    const v = view({ pending: pendingRows, pendingObservation: { state: 'unknown', reason: 'observation-failed' } });
    render(<ClaimNoticesBody view={v} nowMs={NOW} />);
    expect(screen.queryByText('would post')).toBeNull();
    expect(screen.queryByText('first notice body')).toBeNull();
    expect(screen.getByText(/pending unknown \(observation-failed\)/)).toBeInTheDocument();
  });
});
