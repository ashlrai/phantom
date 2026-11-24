import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { afterEach, expect, it, vi } from 'vitest';
import { buildAutonomy, isSelfImprovementPath, readAutonomy, type AutonomyInput } from '../src/core/fleet/autonomy.js';
import { cmdAutonomy } from '../src/cli/autonomy.js';
import { parseMainGuardianStatus } from '../src/core/fleet/main-health.js';
const now = Date.parse('2026-11-17T12:00:00Z');
const at = (hours = 1) => new Date(now - hours * 3_600_000).toISOString();
const bot = { login: 'builder', type: 'Bot' }; const human = { login: 'reviewer', type: 'User' };
const pull = (number = 1, extra = {}) => ({ event: 'outcome', state: 'MERGED', ts: at(), repo: 'ashlrai/phantom', number,
  author: bot, mergedBy: bot, reviews: [], files: ['src/cli/fleet.ts'], ...extra });
const json = (v: unknown) => JSON.stringify(v);
const input = (rows: unknown[], extra: Partial<AutonomyInput> = {}): AutonomyInput => ({ jobs: rows.map(json), now, releases: [], mains: null, ...extra });
afterEach(() => vi.restoreAllMocks());
it('counts all-agent merges, releases and fleet improvements with a stable wire contract', () => {
  const rows = [pull(), pull(2, { files: ['docs/README.md'] })];
  const report = buildAutonomy(input(rows, { releases: [json({ repo: 'phantom', tag: 'v1', publishedAt: at() })] }));
  expect(report).toMatchObject({ merged: 2, mergedPerHour: 2 / 24, withoutHumanShare: 1, selfImprovementShare: 0.5, releases: 1, actorsKnown: 2, filesKnown: 2 });
  expect(report.headline).toBe('2 merged, 100% without a person, 50% improved the fleet itself');
  expect(json(buildAutonomy(input(rows.reverse(), { releases: [json({ repo: 'phantom', tag: 'v1', publishedAt: at() })] })))).toBe(json(report));
  expect(Object.keys(report)).toEqual(['schema', 'generatedAt', 'windowHours', 'merged', 'mergedPerHour', 'withoutHumanShare', 'selfImprovementShare', 'releases', 'mainGreenShare', 'headline', 'actorsKnown', 'filesKnown', 'malformedLines', 'pathRules']);
});
it('reads jobs-ledger dialect spellings for outcome rows', () => {
  const dialect = { type: 'outcome', job_id: 'RQ-DIALECT-1', phase: 'MERGED', recordedAt: at(),
    repo: 'ashlrai/phantom', html_url: 'https://github.com/ashlrai/phantom/pull/88',
    author: bot, mergedBy: bot, reviews: [], files: ['src/cli/fleet.ts'] };
  const report = buildAutonomy(input([pull(), dialect]));
  expect(report.merged).toBe(2);
  expect(report.malformedLines).toBe(0);
});
it.each(['author', 'mergedBy', 'reviews'])('detects a human %s even when other actors are missing', role => {
  const extra = role === 'reviews' ? { reviews: [{ state: 'APPROVED', author: human }] } : { [role]: human };
  expect(buildAutonomy(input([pull(), pull(2, extra)])).withoutHumanShare).toBe(0.5);
  expect(buildAutonomy(input([pull(1, { author: null, ...extra })])).withoutHumanShare).toBe(0);
});
it.each([{ author: null }, { reviews: undefined }, { mergedBy: { login: 'builder' } }, { reviews: [{ state: 'unrecognized', author: bot }] }, { reviewsComplete: false }])('keeps missing or incomplete actor evidence unknown (%j)', extra => {
  expect(buildAutonomy(input([pull(), pull(2, extra)]))).toMatchObject({ merged: 2, withoutHumanShare: null, actorsKnown: 1 });
});
it('attributes a queue relay to its enqueuer and checks review pagination', () => {
  const queued = { mergedBy: { login: 'github-merge-queue', type: 'Bot' } };
  expect(buildAutonomy(input([pull(1, queued)])).withoutHumanShare).toBeNull();
  expect(buildAutonomy(input([pull(1, { ...queued, enqueuer: human })])).withoutHumanShare).toBe(0);
  expect(buildAutonomy(input([pull(1, { ...queued, enqueuer: bot, reviews: { nodes: [], pageInfo: { hasNextPage: false } } })])).withoutHumanShare).toBe(1);
  expect(buildAutonomy(input([pull(1, { reviews: { nodes: [], pageInfo: { hasNextPage: true } } })])).withoutHumanShare).toBeNull();
});
it('does not infer actors from a lane and counts earliest unique PR outcomes in the chosen window', () => {
  const r = pull(1, { url: 'https://github.com/ashlrai/phantom/pull/1', author: null, lane: 'codex-cmp' });
  expect(buildAutonomy(input([r, { ...r, ts: at(0) }, pull(2, { ts: at(25) }), pull(3, { ts: at(-1) })], { hours: 2 }))).toMatchObject({ merged: 1, mergedPerHour: 0.5, withoutHumanShare: null });
  expect(buildAutonomy(input([pull(1, { ts: at(25) }), pull()]))).toMatchObject({ merged: 0, withoutHumanShare: null });
});
it.each(['contrib/router/policy.ts', 'src/core/drive/nodes/router.ts', 'src/core/run/router.ts', 'src/core/drive/nodes/queue-v1.ts', 'src/core/router-gateway/pick.ts', 'src/core/routing/pick.ts', 'contrib/mac/dispatchd.py', 'contrib/mac/restock.py', 'src/core/queue/index.ts', 'src/core/fleet/main-health.ts', 'src/cli/fleet-empties.ts', 'src/web-ui/routes/verse/fleet/Card.tsx', 'src/web-ui/routes/fleet-dashboard/FleetView.tsx'])('matches fleet-owned path %s', path => expect(isSelfImprovementPath(path)).toBe(true));
it.each(['docs/fleet.md', 'src/core/queueing.ts', '/src/cli/fleet.ts', '../src/cli/fleet.ts', 'src/core/queue/../other.ts'])('rejects unrelated or unsafe path %s', path => expect(isSelfImprovementPath(path)).toBe(false));
it('keeps missing and truncated file evidence unknown and scopes paths to Phantom', () => {
  expect(buildAutonomy(input([pull(1, { files: undefined })])).selfImprovementShare).toBeNull();
  expect(buildAutonomy(input([pull(1, { files: ['docs/a.md'], filesComplete: false })])).selfImprovementShare).toBeNull();
  expect(buildAutonomy(input([pull(1, { repo: 'sample/app' })])).selfImprovementShare).toBe(0);
});
it('distinguishes a quiet empty window, unreadable evidence and recorded zero merges', () => {
  for (const jobs of [null, [], ['bad-json'], [json({ ts: at(), garbage: true })]]) expect(buildAutonomy({ ...input([]), jobs })).toMatchObject({ merged: null, withoutHumanShare: null, selfImprovementShare: null });
  expect(buildAutonomy(input([{ event: 'launch', job: 'RQ-ONE', ts: at() }]))).toMatchObject({ merged: 0, withoutHumanShare: null });
  expect(buildAutonomy(input([pull()], { releases: null }))).toMatchObject({ releases: null, mainGreenShare: null });
  expect(buildAutonomy(input([pull()], { releases: ['{}'] })).releases).toBeNull();
});
it('reports current guardian repository share only when fresh and all states are known', () => {
  const m = { ...parseMainGuardianStatus('', now), source: 'ok' as const, stale: false, guardianOff: false };
  const repo = { repo: 'sample', branch: 'main', sha: null, state: 'green' as const, checkedAt: null, failingCheck: null, fixJobs: [], emptyAttempts: 0, retryHold: false, nightlyRed: null };
  const mains = { ...m, repos: [repo, { ...repo, state: 'red' as const }] };
  expect(buildAutonomy(input([], { mains })).mainGreenShare).toBe(0.5);
  for (const override of [{ stale: true }, { guardianOff: true }, { repos: [{ ...repo, state: 'unknown' as const }] }]) expect(buildAutonomy(input([], { mains: { ...mains, ...override } })).mainGreenShare).toBeNull();
});
it('reads existing local exports and gives the CLI identical JSON without leaking actor or file details', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-'));
  try {
    mkdirSync(join(dir, 'metrics')); writeFileSync(join(dir, 'metrics/jobs.jsonl'), json(pull(1, { author: undefined, mergedBy: undefined, reviews: undefined, files: undefined })));
    writeFileSync(join(dir, 'metrics/growth-pulls-1d.json'), json({ pulls: [pull()] }));
    const report = await readAutonomy({ runsDir: dir, now });
    expect(report).toMatchObject({ withoutHumanShare: 1, selfImprovementShare: 1, releases: null });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdAutonomy(['--json'], { runsDir: dir, now })).toBe(0); expect(log).toHaveBeenLastCalledWith(json(report));
    expect(await cmdAutonomy(['--hours', '2'], { runsDir: dir, now })).toBe(0); expect(log.mock.lastCall?.[0]).toContain('Last 2 hours: 0.5 merged/hour');
    for (const args of [['--hours'], ['--hours', '0'], ['--hours', '721'], ['--hours', '0.5'], ['--json', '--json'], ['--bad']]) expect(await cmdAutonomy(args, { runsDir: dir })).toBe(2);
    expect(json(report)).not.toContain('builder');
    const api = createFleetRunsApi({ runsDir: dir, now: () => now });
    for (const method of ['GET', 'POST']) {
      let status = 0; let body = '';
      const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
      expect(await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/runs/autonomy', method)).toBe(true);
      expect(status).toBe(method === 'GET' ? 200 : 405);
      if (method === 'GET') expect(JSON.parse(body)).toEqual(report);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('uses a recorded merge time instead of backfill observation time', () => {
  expect(buildAutonomy(input([pull(1, { mergedAt: at(25) })])).merged).toBe(0);
});

it('retains human evidence across aliases and counts unidentified releases separately', () => {
  for (const extra of [{ author: { __typename: 'Bot', type: 'User' } }, { openedBy: human }]) expect(buildAutonomy(input([pull(1, extra)])).withoutHumanShare).toBe(0);
  expect(buildAutonomy(input([], { releases: [json({ publishedAt: at() }), json({ publishedAt: at() })] })).releases).toBe(2);
  const release = json({ repo: 'phantom', tag: 'v1', publishedAt: at() });
  expect(buildAutonomy(input([], { releases: [release, release] })).releases).toBe(1);
  const pulls = [pull(1, { mergedAt: at(25) }), pull(1, { mergedAt: at() })];
  const report = buildAutonomy(input([pull()], { pulls }));
  expect(report.merged).toBe(0);
  expect(json(buildAutonomy(input([pull()], { pulls: pulls.reverse() })))).toBe(json(report));
});
