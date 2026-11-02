import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { repoMix, repoMixLine, repoShort } from './fleet-lanes-model.js';

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const withRepos = (...repos: string[]): FleetRuns => ({
  ...runs, workers: repos.map((repo, i) => ({ job: `job-${i}`, repo, lane: 'codex', tier: 'work', ageSeconds: i })),
});

describe('worker repository mix', () => {
  it('shortens repository names and handles empty input', () => {
    expect(repoShort('ashlrai/phantom')).toBe('phantom');
    expect(repoShort(`owner/${'a'.repeat(33)}`)).toBe(`${'a'.repeat(31)}…`);
    expect(repoShort('  owner/ repo  ')).toBe('repo');
    expect(repoShort('')).toBe('—');
    expect(repoShort('owner/')).toBe('—');
  });

  it('counts Phantom case-insensitively and sorts the other names', () => {
    expect(repoMix(withRepos('ashlrai/phantom', 'phantom', 'Phantom', 'acme/zebra', 'acme/alpha'))).toEqual({
      total: 5, phantom: 3, others: [{ repo: 'alpha', count: 1 }, { repo: 'zebra', count: 1 }],
    });
    expect(repoMix(withRepos('a/zebra', 'b/zebra', 'a/alpha')).others).toEqual([
      { repo: 'zebra', count: 2 }, { repo: 'alpha', count: 1 },
    ]);
  });

  it('formats empty, all-Phantom and larger mixed fleets', () => {
    expect(repoMixLine(repoMix(runs))).toBe('0 workers');
    expect(repoMixLine(repoMix(withRepos('phantom', 'ashlrai/phantom')))).toBe('2 of 2 on phantom');
    expect(repoMixLine(repoMix(withRepos('phantom', 'a/e', 'a/d', 'a/c', 'a/b', 'a/a'))))
      .toBe('1 of 6 on phantom · others: a 1, b 1, c 1, d 1 +1 more');
  });
});
