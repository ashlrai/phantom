import { describe, expect, it } from 'vitest';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { runningMixLines, runningMixSummary } from './running-mix-lines.js';

function runs(workers: Array<{ lane: string; job: string }>, claimed: FleetRunsV1['claimed'] = []): FleetRunsV1 {
  return {
    v: 1, generatedAt: '2026-10-31T00:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, host: null,
    lanes: [], workers: workers.map((w) => ({ ...w, repo: 'example/fake', tier: 'fake', ageSeconds: null })), claimed,
    leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
    events: [], codexPersonal: null, inbox: [], drop: null,
  };
}

const filler = 'RQ-ABC1A20261031Q8';

describe('running mix', () => {
  it('classifies workers by lane, orders by count, and excludes claims', () => {
    const lines = runningMixLines(runs([
      { lane: 'small', job: 'RQ-PHX-one' },
      { lane: 'big', job: 'RQ-PHX-two' }, { lane: 'big', job: 'FIXUP-one' },
      { lane: 'big', job: filler }, { lane: 'big', job: 'something-else' },
    ], [{ lane: 'big', job: filler, tier: 'fake', at: '2026-10-31T00:00:00Z' }]));
    expect(lines).toEqual([
      { lane: 'big', running: 4, text: '1 Phantom · 1 fix-up · 1 filler (25%) · 1 other', tone: 'neutral' },
      { lane: 'small', running: 1, text: '1 Phantom', tone: 'neutral' },
    ]);
    expect(runningMixSummary(lines)).toBe('5 running · 1 filler');
  });

  it.each([[6, 'warning', '37.5%'], [2, 'neutral', '12.5%'], [3, 'warning', '30%']])(
    'uses the unrounded filler share for %i filler workers', (fillers, tone, percentage) => {
      const total = fillers === 3 ? 10 : 16;
      const workers = Array.from({ length: total }, (_, i) => ({ lane: 'codex-personal', job: i < fillers ? filler : 'RQ-PHX-job' }));
      const lines = runningMixLines(runs(workers));
      expect(lines[0]?.tone).toBe(tone);
      expect(lines[0]?.text).toContain(`${fillers} filler (${percentage})`);
      expect(runningMixSummary(lines)).toBe(`${total} running · ${fillers} filler`);
    },
  );

  it('returns no lines for missing or empty workers', () => {
    expect(runningMixLines(null)).toEqual([]);
    expect(runningMixLines(runs([]))).toEqual([]);
    expect(runningMixSummary([])).toBe('0 running · 0 filler');
  });
});
