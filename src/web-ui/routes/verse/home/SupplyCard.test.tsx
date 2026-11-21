import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupplyDoctorReport } from '../../../../core/fleet/supply-doctor.js';
import { asSupplyReport, supplyCardModel } from '../../../../core/fleet/supply-card.js';
import { SupplyBody, SupplyCard, SupplyCardPhone } from './SupplyCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown, error: undefined as Error | undefined } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => () => undefined }));
vi.mock('../shell/section-visibility.js', () => ({ usePollWhileVisible: () => undefined }));

const base = {
  schema: 'doctor.supply.v1', generatedAt: new Date('2026-11-19T15:00:00').toISOString(), runsDir: '/runs',
  hook: { enabled: true, switch: 'autofill.off', note: 'x' },
} as const;
const LANDED = {
  ...base,
  ingested: { state: 'known', path: '/runs/leader/drop/ingested.tsv', sources: [
    { source: 'gap', lastIngest: '2026-11-19 14:40:00', count24h: 3 },
    { source: 'claude', lastIngest: '2026-11-19 14:00:00', count24h: 5 },
    { source: 'sol', lastIngest: '2026-11-19 13:00:00', count24h: 2 },
    { source: 'leader', lastIngest: '2026-11-19 12:00:00', count24h: 4 },
  ] },
  rejected: { state: 'known', path: '/runs/leader/drop/done', total24h: 3, byReason: { 'bad-header': 1, 'too-large': 2 } },
  selfSupply: { landed24h: 3, lastLanded: '2026-11-19 14:40:00' },
  verdict: 'self-supply landed 3 jobs in 24 h (last 2026-11-19 14:40:00)',
} as unknown as SupplyDoctorReport;
const NOT_LANDED = {
  ...base,
  ingested: { state: 'known', path: '/runs/leader/drop/ingested.tsv', sources: [{ source: 'claude', lastIngest: '2026-11-19 14:30:00', count24h: 2 }] },
  rejected: { state: 'known', path: '/runs/leader/drop/done', total24h: 0, byReason: {} },
  selfSupply: { landed24h: 0, lastLanded: null },
  verdict: 'self-supply has not landed a job in 24 h',
} as unknown as SupplyDoctorReport;
const UNREADABLE = {
  ...base,
  ingested: { state: 'unknown', path: '/runs/leader/drop/ingested.tsv', why: 'missing' },
  rejected: { state: 'unknown', path: '/runs/leader/drop/done', why: 'missing' },
  selfSupply: { landed24h: null, lastLanded: null },
  verdict: 'self-supply is unknown: cannot read /runs/leader/drop/ingested.tsv (missing)',
} as unknown as SupplyDoctorReport;

afterEach(cleanup);

describe('supplyCardModel', () => {
  it('groups sources into Leader, Core and Gap and names the top reject and the last landed age', () => {
    const m = supplyCardModel(LANDED);
    expect(m.tone).toBe('ok');
    expect(m.sources).toEqual([{ label: 'Leader', count: 4 }, { label: 'Core', count: 7 }, { label: 'Gap', count: 3 }]);
    expect(m.rejects).toBe('Top reject reason: too-large, 2 in 24 h.');
    expect(m.lastLanded).toBe('Last landed job: 20 min ago.');
  });
  it('shows the self-tick line (the live build moved to the Leader card), or unknown for an older Mac', () => {
    const full = { ...LANDED, build: { verdict: 'live build is 644 commits behind master; merged fleet features may not be running' }, selfTick: { line: 'no self-tick run recorded' } } as unknown as SupplyDoctorReport;
    const m = supplyCardModel(full);
    expect(m).not.toHaveProperty('buildLine');
    expect(m.selfTickLine).toBe('Self-tick: no self-tick run recorded.');
    expect(supplyCardModel(LANDED).selfTickLine).toContain('unknown');
  });
  it('not landed: warns, zero gap, says nothing landed yet', () => {
    const m = supplyCardModel(NOT_LANDED);
    expect(m.tone).toBe('warn');
    expect(m.sources).toEqual([{ label: 'Leader', count: 0 }, { label: 'Core', count: 2 }, { label: 'Gap', count: 0 }]);
    expect(m.rejects).toBe('Nothing rejected in 24 h.');
    expect(m.lastLanded).toBe('No self-supplied job has landed yet.');
  });
  it('unreadable files read unknown with the path, never zero', () => {
    const m = supplyCardModel(UNREADABLE);
    expect(m.tone).toBe('unknown');
    expect(m.sources.every(s => s.count === null)).toBe(true);
    expect(m.sourcesNote).toContain('/runs/leader/drop/ingested.tsv');
    expect(m.rejects).toContain('/runs/leader/drop/done');
    expect(m.lastLanded).toContain('/runs/leader/drop/ingested.tsv');
  });
  it('only a doctor.supply.v1 object is a report', () => {
    expect(asSupplyReport(LANDED)).toBe(LANDED);
    expect(asSupplyReport({ ...LANDED, schema: 'doctor.supply.v2' })).toBeNull();
    expect(asSupplyReport(null)).toBeNull();
    expect(asSupplyReport({ error: 'nope' })).toBeNull();
  });
});

describe('Supply card', () => {
  it('landed: verdict first, per-source counts, top reject, age, and the command', () => {
    render(<SupplyBody report={LANDED} />);
    expect(screen.getByRole('status').textContent).toBe('self-supply landed 3 jobs in 24 h (last 2026-11-19 14:40:00)');
    expect(within(screen.getByRole('list', { name: 'Jobs landed in 24 hours' })).getAllByRole('listitem').map(li => li.textContent))
      .toEqual(['Leader: 4 in 24 h', 'Core: 7 in 24 h', 'Gap: 3 in 24 h']);
    expect(screen.getByText('Top reject reason: too-large, 2 in 24 h.')).toBeTruthy();
    expect(screen.getByText('Last landed job: 20 min ago.')).toBeTruthy();
    expect(screen.getByText('phm doctor supply --json').tagName).toBe('CODE');
  });
  it('not landed: says so in words with zero gap jobs', () => {
    render(<SupplyBody report={NOT_LANDED} />);
    expect(screen.getByRole('status').textContent).toBe('self-supply has not landed a job in 24 h');
    expect(screen.getByText('Gap: 0 in 24 h')).toBeTruthy();
    expect(screen.getByText('Core: 2 in 24 h')).toBeTruthy();
  });
  it('unreadable: no list, an unknown line with the path', () => {
    render(<SupplyBody report={UNREADABLE} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText(/Jobs per source: unknown \(\/runs\/leader\/drop\/ingested.tsv is missing\)/)).toBeTruthy();
  });
  it('no report: unknown with the reason, never blank', () => {
    render(<SupplyBody report={null} error="the Mac did not answer. Try again." />);
    expect(screen.getByRole('status').textContent).toBe('Self-supply is unknown: the Mac did not answer. Try again.');
  });
  it.each([['desktop', SupplyCard, 'Supply'], ['phone', SupplyCardPhone, 'Supply']] as const)('%s wrapper titles the card Supply and renders the report', (_n, Component, name) => {
    state.read = { status: 'success', data: LANDED, error: undefined };
    render(<Component />);
    const card = within(screen.getByRole('region', { name }));
    expect(card.getByText('Core: 7 in 24 h')).toBeTruthy();
  });
  it('a failed first read says unknown', () => {
    state.read = { status: 'error', data: undefined, error: new Error('HTTP 503') };
    render(<SupplyCard />);
    expect(screen.getByRole('status').textContent).toContain('Self-supply is unknown');
  });
});
