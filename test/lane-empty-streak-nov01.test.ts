/**
 * fleet/lane-empty-streak.ts — the Nov 1 claude-api burn: three queued jobs
 * launched ~8 minutes apart on a rejected token, each ending EMPTY_DONE about
 * ten minutes later, nothing published. Pure projection, no IO. Fixture ids
 * and lanes only — no secrets.
 */
import { describe, expect, it } from 'vitest';
import {
  laneEmptyStreaks,
  type LaneStreak,
} from '../src/core/fleet/lane-empty-streak.js';

const NOW = Date.parse('2026-11-01T06:00:00Z');

const LOG = [
  // Older than the default 90-minute window: never evidence.
  '2026-11-01 03:00:00 LAUNCH RQ-OLD9A103123Q8 phantom-secrets claude-api mid',
  '2026-11-01 03:10:00 EMPTY_DONE RQ-OLD9A103123Q8',
  // codex-personal: two launches, both published.
  '2026-11-01 05:10:00 LAUNCH RQ-CDX1A103123Q8 phantom codex-personal mid',
  '2026-11-01 05:20:00 PUBLISHED RQ-CDX1A103123Q8 https://github.com/ashlrai/phantom/pull/7',
  '2026-11-01 05:30:00 LAUNCH RQ-CDX2A103123Q8 phantom codex-personal mid',
  '2026-11-01 05:41:00 PUBLISHED RQ-CDX2A103123Q8 https://github.com/ashlrai/phantom/pull/8',
  // claude-api: the burn — three launches, three empties, zero published.
  '2026-11-01 05:34:12 LAUNCH RQ-PS9A103123Q8 phantom-secrets claude-api mid',
  '2026-11-01 05:43:16 LAUNCH RQ-PS10A103123Q8 phantom-secrets claude-api mid',
  '2026-11-01 05:44:12 EMPTY_DONE RQ-PS9A103123Q8',
  '2026-11-01 05:45:30 LAUNCH RQ-PS11A103123Q8 phantom-secrets claude-api mid',
  '2026-11-01 05:55:30 EMPTY_DONE RQ-PS11A103123Q8',
  '2026-11-01 05:56:21 EMPTY_DONE RQ-PS10A103123Q8',
  // claude: two of two empty — under the three-launch floor, not a streak.
  '2026-11-01 05:15:00 LAUNCH RQ-CL01A103123Q8 phantom claude mid',
  '2026-11-01 05:25:00 EMPTY RQ-CL01A103123Q8',
  '2026-11-01 05:35:00 LAUNCH RQ-CL02A103123Q8 phantom claude mid',
  '2026-11-01 05:45:00 SKIPPED-EMPTY RQ-CL02A103123Q8',
  // devin: launched, still running.
  '2026-11-01 05:50:00 LAUNCH RQ-DVN1A103123Q8 phantom devin high',
  // Malformed: a bad job id. Skipped, counted, never thrown.
  '2026-11-01 05:47:00 LAUNCH RQ-BAD!! phantom claude-api mid',
].join('\n');

const lane = (lanes: LaneStreak[], name: string) => lanes.find(row => row.lane === name);

describe('laneEmptyStreaks over the Nov 1 dispatch-events.log', () => {
  const report = laneEmptyStreaks(LOG, NOW);

  it('names claude-api burning: 3 launches, 3 empty, 0 published, ~10 min median', () => {
    expect(report.v).toBe(1);
    expect(report.source).toBe('ok');
    expect(report.windowMinutes).toBe(90);
    expect(report.generatedAt).toBe('2026-11-01T06:00:00.000Z');
    const claudeApi = lane(report.lanes, 'claude-api');
    expect(claudeApi).toMatchObject({
      verdict: 'burning', launches: 3, ended: 3, empties: 3,
      published: 0, running: 0, lastEmptyJob: 'RQ-PS10A103123Q8',
      lastEmptyAt: '2026-11-01T05:56:21Z',
    });
    expect(claudeApi!.medianMinutes).toBeCloseTo(10, 0);
  });

  it('sorts the burning lane first', () => {
    expect(report.lanes[0]).toMatchObject({ lane: 'claude-api', verdict: 'burning' });
  });

  it('keeps a publishing lane ok', () => {
    expect(lane(report.lanes, 'codex-personal')).toMatchObject({
      verdict: 'ok', launches: 2, ended: 2, empties: 0, published: 2, running: 0,
      lastEmptyJob: null, lastEmptyAt: null,
    });
  });

  it('reports a launched job with no terminal event as running', () => {
    expect(lane(report.lanes, 'devin')).toMatchObject({
      verdict: 'ok', launches: 1, ended: 0, running: 1, medianMinutes: null,
    });
  });

  it('keeps a two-of-two empty lane ok — under the three-launch floor', () => {
    expect(lane(report.lanes, 'claude')).toMatchObject({
      verdict: 'ok', launches: 2, ended: 2, empties: 2, published: 0,
    });
  });

  it('ignores events older than the window', () => {
    // The 03:00 claude-api launch and its EMPTY_DONE count for nothing:
    // launches stays 3 and the old job appears nowhere.
    expect(lane(report.lanes, 'claude-api')!.launches).toBe(3);
    expect(JSON.stringify(report.lanes)).not.toContain('RQ-OLD9A103123Q8');
  });

  it('counts the malformed line and never throws', () => {
    expect(report.malformedLines).toBe(1);
  });

  it('answers an empty lane list on an empty log', () => {
    expect(laneEmptyStreaks('', NOW)).toMatchObject({ source: 'ok', lanes: [], malformedLines: 0 });
  });

  it('clamps the window to 15..1440 minutes', () => {
    expect(laneEmptyStreaks(LOG, NOW, 5).windowMinutes).toBe(15);
    expect(laneEmptyStreaks(LOG, NOW, 99999).windowMinutes).toBe(1440);
    // A 30-minute window still sees the three claude-api launches (05:34+).
    expect(lane(laneEmptyStreaks(LOG, NOW, 30).lanes, 'claude-api')!.verdict).toBe('burning');
    // A 15-minute window sees only the 05:45:30 claude-api and 05:50 devin launches.
    expect(laneEmptyStreaks(LOG, NOW, 15).lanes.map(row => row.lane)).toEqual(['claude-api', 'devin']);
  });
});
