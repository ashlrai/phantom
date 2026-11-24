/** The build-stale alert and the card line: under limit, over limit (one notice across three ticks), recovered, unknown. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildLiveReport } from '../src/core/fleet/build-live.js';
import { buildStaleness, liveBuildLine } from '../src/core/fleet/build-stale.js';
import { buildPulseAlerts, PULSE_NOTIFY_STATE, readPulseAlerts, type PulseAlertInputs } from '../src/core/fleet/pulse-alerts.js';
import type { StarvedRead } from '../src/core/fleet/lane-starved.js';
import type { SpendSnapshot } from '../src/core/usage/spend.js';
import { throughputMarks } from '../src/core/fleet/throughput.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const HOUR = 3_600_000;
const calm: StarvedRead = { lanes: {}, waiting_elsewhere: 0, open_rows: 0 };
const spend = { schema: 'usage.spend.v1', v: 1, asOf: new Date(NOW).toISOString(), headline: 'x', pools: [{ pool: 'claude', status: 'on-pace', projectedUnusedPercent: 5, resetsIn: '10h 0m' }] } as unknown as SpendSnapshot;
const launched = JSON.stringify({ event: 'launch', ts: new Date(NOW - 60_000).toISOString(), job: 'RQ-FAKE-1', lane: 'claude', repo: 'phantom' });
const busy = (build: PulseAlertInputs['build']): PulseAlertInputs => ({
  marks: throughputMarks(launched, NOW - 72 * HOUR, NOW).marks, starved: calm, spend, build });

const report = (behind: BuildLiveReport['behind'], sha = 'abc1234def5678'): Pick<BuildLiveReport, 'commit' | 'behind'> => ({
  commit: { state: 'known', sha, source: 'git' }, behind });
const behindBy = (count: number, hoursAgo: number | null) => report({ state: 'known', count, ref: 'origin/master', since: hoursAgo === null ? null : new Date(NOW - hoursAgo * HOUR).toISOString() });
const unknown = { commit: { state: 'unknown', why: 'not a git checkout' }, behind: { state: 'unknown', why: 'the running commit is unknown' } } as const;

describe('buildStaleness and liveBuildLine', () => {
  it('current, a little behind, stale by commits, stale by age, unknown', () => {
    expect(buildStaleness(behindBy(0, null), NOW)).toBe('current');
    expect(buildStaleness(behindBy(3, 2), NOW)).toBe('behind');
    expect(buildStaleness(behindBy(50, 2), NOW)).toBe('behind');
    expect(buildStaleness(behindBy(51, 2), NOW)).toBe('stale');
    expect(buildStaleness(behindBy(3, 25), NOW)).toBe('stale');
    expect(buildStaleness(behindBy(3, 25), NOW, { commits: 50, hours: 48 })).toBe('behind');
    expect(buildStaleness(unknown, NOW)).toBe('unknown');
    expect(buildStaleness(undefined, NOW)).toBe('unknown');
  });
  it('the card line is plain words', () => {
    expect(liveBuildLine(behindBy(0, null))).toBe('Live build: current');
    expect(liveBuildLine(report({ state: 'known', count: 644, ref: 'origin/master', since: '2026-11-12T08:00:00.000Z' }))).toBe('Live build: 644 behind (since Nov 12)');
    expect(liveBuildLine(behindBy(4, null))).toBe('Live build: 4 behind');
    expect(liveBuildLine(unknown)).toBe('Live build: unknown');
    expect(liveBuildLine(undefined)).toBe('Live build: unknown');
  });
});

describe('build-stale pulse alert', () => {
  let runs: string;
  beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'build-stale-')); });
  afterEach(async () => { await rm(runs, { recursive: true, force: true }); });
  // The launch row ages with the clock, so later ticks also raise "stalled"; only build-stale notices are counted.
  const sent = vi.fn(async (_text: string) => undefined);
  const email = async (text: string) => { if (text.includes('running phm')) await sent(text); };
  const tick = (build: PulseAlertInputs['build'], now: number, _unused?: unknown) =>
    readPulseAlerts({ runsDir: runs, now, notify: true, read: async () => busy(build), senders: { email } });
  const stateFile = async () => Object.keys(JSON.parse(await readFile(join(runs, PULSE_NOTIFY_STATE), 'utf8').catch(() => '{}')));

  it('under the limits: no alert', () => {
    const pulse = buildPulseAlerts(busy(behindBy(10, 3)), NOW);
    expect(pulse.alerts).toEqual([]);
    expect(pulse.unknown).toEqual([]);
  });

  it('over the limit: one alert in plain words', () => {
    const [alert, ...rest] = buildPulseAlerts(busy(behindBy(644, 200)), NOW).alerts;
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ kind: 'build-stale', lane: 'abc1234',
      detail: 'The running phm is 644 commits behind master (since Nov 12). Merged fleet features are not live.', fix_hint: 'Fix: rebuild from master.' });
  });

  it('over the limit by age alone, with a configurable limit', () => {
    expect(buildPulseAlerts(busy(behindBy(2, 30)), NOW).alerts.map(a => a.kind)).toEqual(['build-stale']);
    expect(buildPulseAlerts({ ...busy(behindBy(2, 30)), buildLimits: { commits: 50, hours: 48 } }, NOW).alerts).toEqual([]);
  });

  it('three ticks, one notice; a new running commit is a new notice; recovery clears it', async () => {
    await tick(behindBy(644, 200), NOW);
    await tick(behindBy(645, 200), NOW + 20 * 60_000);
    await tick(behindBy(646, 200), NOW + 3 * HOUR); // past the hour: a normal alert would repeat, this one does not
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![0]).toBe('Phantom alert: The running phm is 644 commits behind master (since Nov 12). Merged fleet features are not live. Fix: rebuild from master.');
    expect((await stateFile()).filter(k => k.startsWith('build-stale'))).toEqual(['build-stale:abc1234']);

    await tick(behindBy(0, null), NOW + 4 * HOUR); // rebuilt: current
    expect((await stateFile()).filter(k => k.startsWith('build-stale'))).toEqual([]);
    await tick(behindBy(700, 300), NOW + 5 * HOUR); // stale again: a fresh notice
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('unidentified (no embedded commit, no git checkout): one alert, one notice, cleared once identified', async () => {
    const [alert, ...rest] = buildPulseAlerts(busy(unknown), NOW).alerts;
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ kind: 'build-stale', lane: 'unidentified', since: null,
      detail: 'The running phm cannot say which commit it was built from (not a git checkout), so nobody can tell whether it is current.',
      fix_hint: 'Fix: rebuild from a master checkout.' });
    expect(buildPulseAlerts(busy(unknown), NOW).unknown).toEqual([]);
    await tick(unknown, NOW);
    await tick(unknown, NOW + 3 * HOUR);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(await stateFile()).toContain('build-stale:unidentified');
    await tick(behindBy(0, null), NOW + 4 * HOUR);
    expect((await stateFile()).filter(k => k.startsWith('build-stale'))).toEqual([]);
  });

  it('identified but not measurable (no fetched master ref): no alert, and the gap is listed', async () => {
    const noRef = { commit: { state: 'known', sha: 'abc1234def5678', source: 'build' }, behind: { state: 'unknown', why: 'no local origin/master ref (nothing fetched yet)' } } as const;
    const pulse = buildPulseAlerts(busy(noRef), NOW);
    expect(pulse.alerts).toEqual([]);
    expect(pulse.unknown).toEqual(['Live build: how far behind master is not known here.']);
    expect(buildPulseAlerts(busy(null), NOW).alerts).toEqual([]);
    expect(buildPulseAlerts(busy(undefined), NOW).alerts).toEqual([]);
    await tick(noRef, NOW);
    expect(sent).not.toHaveBeenCalled();
  });
});
