import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PulseV1 } from '../../../../core/fleet/pulse.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { driftLine, type SelfDriftV1 } from '../../../../core/release/drift-shape.js';
import { PulseCard } from './PulseCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown }, drift: { status: 'success', data: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: (def: { key: string }) => def.key === 'self-drift' ? state.drift : state.read, useRefetch: () => vi.fn() }));

const none = (line: string) => ({ value: null, trend: 'unknown' as const, better: null, line });
/** The `phm fleet pulse --json` bodies for an empty fleet and a normal one; fake repos and pools only. */
const EMPTY: PulseV1 = {
  schema: 'fleet.pulse.v1', v: 1, asOf: '2026-11-17T12:00:00.000Z', verdict: 'unknown', headline: 'Partly unknown: 5 numbers could not be read.',
  mergesPerHour: { ...none('Unknown: the job metrics file could not be read.'), sparkline: [] },
  medianMergeSeconds: none('Unknown: the job metrics file could not be read.'),
  mainsGreen: { ...none('Unknown: the main guardian status could not be read.'), total: null, red: [] },
  daysSinceRelease: { ...none('Unknown: no guarded repo is known to read releases for.'), worstRepo: null, repos: [] },
  poolsOnPace: { ...none('Unknown: the spend snapshot could not be read.'), measured: null },
};
const NORMAL: PulseV1 = {
  ...EMPTY, verdict: 'watch', headline: 'Watch: 1 pool will leave allowance unused.',
  mergesPerHour: { value: 4.2, trend: 'up', better: true, line: '101 PRs merged in the last 24 hours, 80 the day before.', sparkline: [2, 3, 5, 4, 6, 4, 3, 5, 4, 6, 5, 4, 3, 4, 5, 6, 4, 3, 5, 4, 5, 4, 3, 5] },
  medianMergeSeconds: { value: 1260, trend: 'down', better: true, line: 'Half of PRs merge within 21m 0s of publishing.' },
  mainsGreen: { value: 7, total: 7, red: [], trend: 'unknown', better: null, line: 'Every main branch is green.' },
  daysSinceRelease: { value: 9, trend: 'up', better: false, line: 'locus last released 9 days ago (v1.2.0).', worstRepo: 'locus', repos: [{ repo: 'locus', tag: 'v1.2.0', days: 9 }] },
  poolsOnPace: { value: 2, measured: 3, trend: 'unknown', better: null, line: '2 of 3 pools on pace; claude will leave 8% unused.' },
};
const TITLES = ['PRs merged per hour', 'Median publish to merge', 'Main branches green', 'Days since last release', 'Pools on pace'];
let viewport: ViewportMock | null = null;
const show = (data: unknown, width: number, status = 'success') => { viewport = mockViewport(width); state.read = { status, data }; return render(<PulseCard />); };
const row = (name: string) => within(screen.getByRole('listitem', { name }));
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; state.drift = { status: 'success', data: undefined }; });

describe.each([['390 px', 390], ['desktop width', 1440]])('Pulse card at %s', (_name, width) => {
  it('normal: the headline, then five numbers with an arrow and a plain line each', () => {
    show(NORMAL, width);
    const card = within(screen.getByRole('region', { name: 'Pulse' }));
    expect(card.getByText(NORMAL.headline).getAttribute('data-health')).toBe('stalled');
    expect(card.getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(TITLES);
    expect(row('PRs merged per hour').getByText('4.2')).toBeTruthy();
    expect(row('PRs merged per hour').getByRole('img', { name: 'up, better since yesterday' }).textContent).toBe('↑');
    expect(row('PRs merged per hour').getByRole('img', { name: /^Merged per hour over 24 hours: 2, 3, 5/ }).tagName.toLowerCase()).toBe('svg');
    expect(row('Median publish to merge').getByText('21 min')).toBeTruthy();
    expect(row('Main branches green').getByText('7 of 7')).toBeTruthy();
    expect(row('Main branches green').getByRole('img', { name: 'trend unknown' }).textContent).toBe('?');
    expect(row('Days since last release').getByRole('img', { name: 'up, worse since yesterday' }).getAttribute('data-tone')).toBe('worse');
    expect(row('Days since last release').getByText('locus last released 9 days ago (v1.2.0).')).toBeTruthy();
    expect(row('Pools on pace').getByText('2 of 3')).toBeTruthy();
    expect(row('Pools on pace').getByText('2 of 3 pools on pace; claude will leave 8% unused.')).toBeTruthy();
    expect(card.queryAllByRole('button')).toHaveLength(0);
  });

  it('empty: every number reads unknown with its reason, never 0', () => {
    show(EMPTY, width);
    const card = within(screen.getByRole('region', { name: 'Pulse' }));
    expect(card.getAllByText('unknown')).toHaveLength(5);
    expect(card.queryByText(/^0/)).toBeNull();
    expect(row('Pools on pace').getByText('Unknown: the spend snapshot could not be read.').hasAttribute('data-unknown')).toBe(true);
    expect(card.queryByRole('img', { name: /Merged per hour over/ })).toBeNull();
  });
});

it('says unknown when the read fails, and stays hidden before the read or for another payload', () => {
  show(undefined, 390, 'error');
  expect(screen.getByText('Unknown: the pulse could not be read.')).toBeTruthy();
  cleanup();
  for (const data of [undefined, { error: 'nope' }, { schema: 'home.v1' }]) {
    expect(show(data, 390).container.innerHTML).toBe('');
    cleanup();
  }
});

describe('Running build row', () => {
  const drift = (behindReleases: number | 'unknown', missingFeatures: string[], unknownFeatures: string[] = []): SelfDriftV1 => ({
    schema: 'phantom.self-drift.v1', version: 1, checkedAt: '2026-11-18T12:00:00.000Z', installed: { version: '3.1.0', revision: 'unknown' },
    latestRelease: { tag: 'v3.3.0', at: '2026-11-17T10:00:00.000Z' }, master: { revision: 'unknown', at: 'unknown' }, behindReleases,
    behindCommits: 'unknown', oldestUnshippedMergeAt: 'unknown', liveFeatures: [], missingFeatures: missingFeatures as SelfDriftV1['missingFeatures'],
    unknownFeatures: unknownFeatures as SelfDriftV1['unknownFeatures'], features: [], line: driftLine({ behindReleases, missingFeatures: missingFeatures as SelfDriftV1['missingFeatures'], unknownFeatures: unknownFeatures as SelfDriftV1['unknownFeatures'] }),
  });

  it('up to date: one plain line, nothing to open', () => {
    state.drift = { status: 'success', data: drift(0, []) };
    show(NORMAL, 390);
    expect(row('Running build').getByText('Up to date')).toBeTruthy();
    expect(row('Running build').getByText('3.1.0')).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('behind: the count line, with the not-live features one tap away', () => {
    state.drift = { status: 'success', data: drift(2, ['recut-check', 'yield-stop-list'], ['pulse']) };
    show(NORMAL, 1440);
    const summary = row('Running build').getByText('2 releases behind, 2 fleet features not live yet; 1 feature unknown');
    expect(summary.tagName.toLowerCase()).toBe('summary');
    expect(row('Running build').getAllByRole('listitem').map(item => item.textContent)).toEqual(['recut-check: not live yet', 'yield-stop-list: not live yet', 'pulse: unknown']);
  });

  it('a failed read is unknown; an older server hides the row', () => {
    state.drift = { status: 'error', data: undefined };
    show(NORMAL, 390);
    expect(row('Running build').getByText('Unknown: the running build could not be read.')).toBeTruthy();
    cleanup();
    state.drift = { status: 'success', data: { schema: 'other' } };
    show(NORMAL, 390);
    expect(screen.queryByRole('listitem', { name: 'Running build' })).toBeNull();
  });
});
