import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { fleetBriefText, fleetBriefWithRelease } from './fleet-brief-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], claimed: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const repo = (over: Record<string, unknown>) => ({
  path: '/fake', commitsSinceTag: 5, releaseWorkflow: 'release.yml', notes: [],
  gh: { latestRelease: null, latestRun: null }, ...over,
});
const releases = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy',
  repos: [
    repo({ repo: 'ashlrai/ember', version: '0.4.0', latestTag: 'v0.3.0' }),
    repo({
      repo: 'ashlrai/phantom', version: '3.30.0', latestTag: 'v3.29.15',
      gh: { latestRelease: { tag: 'v3.29.15', name: null, publishedAt: new Date(now - 6 * 86_400_000).toISOString(), draft: false, prerelease: false }, latestRun: null },
    }),
  ],
};

it('appends one release line per repo, phantom first', () => {
  const text = fleetBriefWithRelease(runs, releases, now);
  const phantom = text.indexOf('Release: ashlrai/phantom v3.29.15 shipped 6 days ago · 3.30.0 candidate');
  const ember = text.indexOf('Release: ashlrai/ember nothing shipped yet · 0.4.0 candidate');
  expect(phantom).toBeGreaterThan(-1);
  expect(ember).toBeGreaterThan(phantom);
});
it('reports status unknown when releases is null or unnarrowable', () => {
  expect(fleetBriefWithRelease(runs, null, now)).toContain('Release: status unknown');
  expect(fleetBriefWithRelease(runs, { v: 1, repos: 'bogus' }, now)).toContain('Release: status unknown');
});
it('keeps the base brief as a prefix', () => {
  expect(fleetBriefWithRelease(runs, releases, now).startsWith(fleetBriefText(runs, now))).toBe(true);
  expect(fleetBriefWithRelease(runs, null, now).startsWith(fleetBriefText(runs, now))).toBe(true);
});
