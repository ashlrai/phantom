import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { fleetBriefText, fleetBriefWithRelease } from './fleet-brief-model.js';

it('places merge speed directly above the merged PR list, including in the release brief', () => {
  const merges = { count: 2, perHour: 33, medianOpenToMergeMs: 360_000, items: [
    { repo: 'fake/repo', number: 2410, title: 'Change', openToMergeMs: 2_460_000 },
  ] };
  const runs: FleetRuns = {
    v: 1, generatedAt: '2026-11-01T00:10:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
    lanes: [], workers: [], claimed: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
    mergesLastHour: merges,
    events: [], codexPersonal: null, inbox: [], drop: null,
  };
  const expected = 'Merges: 2 in the last hour · 33/h · median open→merge 6 min · slowest #2410 (41 min)\n- fake/repo #2410 Change';
  expect(fleetBriefText(runs, 0)).toContain(expected);
  expect(fleetBriefWithRelease(runs, null, 0)).toContain(expected);
});
