import { describe, expect, it } from 'vitest';
import { assessReaper, parseReapLog } from '../src/core/fleet/worktrees.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const HOUR = 3_600_000;
const logRow = (at: number, status: string) => JSON.stringify({ at: new Date(at).toISOString(), status, job: 'RQ-FAKE' });
const health = (text: string) => assessReaper({
  now: NOW, sourcesOk: true, eligible: ['RQ-FAKE'], stuckRuns: [], log: { state: 'ok', text },
});

describe('preserved reaper health evidence (#7235)', () => {
  it('ignores future attempts and foreign status rows instead of declaring the reaper healthy', () => {
    const text = [logRow(NOW - 30 * HOUR, 'removed'), logRow(NOW, 'started'), logRow(NOW + HOUR, 'removed')].join('\n');
    expect(health(text)).toMatchObject({ state: 'stale', reason: 'last-run-old', lastRunAgeHours: 30 });
    expect(parseReapLog(logRow(NOW, 'unrecognized'), NOW)).toBeNull();
  });

  it('uses elapsed time, without rounding a recent attempt into the 24-hour stale window', () => {
    expect(health(logRow(NOW - 24 * HOUR + 1, 'removed'))).toMatchObject({ state: 'healthy', reason: 'ran-recently' });
    expect(health(logRow(NOW - 24 * HOUR, 'removed'))).toMatchObject({ state: 'stale', reason: 'last-run-old' });
  });

  it('counts only the newest ten-minute batch, ignoring malformed and partial tail records', () => {
    const text = ['cut first line', 'null', logRow(NOW - 11 * 60_000, 'removed'), logRow(NOW - 10 * 60_000, 'refused'), logRow(NOW, 'failed')].join('\n');
    expect(health(text)).toMatchObject({ state: 'stale', reason: 'last-run-failed', lastRun: { removed: 0, refused: 1, failed: 1 } });
  });
});
