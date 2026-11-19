import { afterEach, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { readEmptyFamilies, EMPTY_FAMILIES_SCHEMA } from '../src/core/fleet/empty-families.js';
import type { EmptyJobsReader } from '../src/core/fleet/empty-jobs.js';

const now = Date.parse('2026-11-19T12:00:00Z');
const row = (job: string, lane: string, empty: boolean) => JSON.stringify({ event: 'finish', job, lane, empty, ts: '2026-11-19T11:00:00Z' });
const reader = (rows: string[], logs: Record<string, string> = {}): EmptyJobsReader => async path =>
  basename(path) === 'jobs.jsonl' ? rows.join('\n') : logs[basename(path)] ?? null;
afterEach(() => vi.restoreAllMocks());

const filler = [1, 2, 3, 4, 5].map(n => `RQ-MD${n}A11180${n}Q8`);
const signin = [1, 2, 3].map(n => `RQ-LOGIN${n}`);
const healthy = [1, 2, 3, 4].map(n => `RQ-HEALTHY-${n}`);
const rows = [
  ...filler.map(id => row(id, 'devin-flash', true)),
  ...signin.map(id => row(id, 'cursor', true)),
  ...healthy.map((id, i) => row(id, 'claude', i === 0)),
];
const logs = Object.fromEntries([
  ...filler.map(id => [`${id}.log`, 'Already on master.\nRESULT EMPTY']),
  ...signin.map(id => [`${id}.log`, 'Error: not logged in\nRESULT EMPTY']),
  ['RQ-HEALTHY-1.log', 'No changes needed.\nRESULT EMPTY'],
]);

it('stops a filler family, reroutes a sign-in family and keeps a healthy one', async () => {
  const report = await readEmptyFamilies(24, '/fixture', now, { read: reader(rows, logs) });
  expect(report?.schema).toBe(EMPTY_FAMILIES_SCHEMA);
  expect(report?.families.map(f => [f.family, f.lane, f.action])).toEqual([
    ['RQ-MD*', 'devin-flash', 'stop'],
    ['RQ-LOGIN*', 'cursor', 'reroute'],
    ['RQ-HEALTHY*', 'claude', 'keep'],
  ]);
  expect(report?.families[0]).toEqual({ family: 'RQ-MD*', lane: 'devin-flash', launches: 5, empty: 5, empty_rate: 1, top_reasons: [{ reason: 'already-on-master', count: 5 }], action: 'stop' });
  expect(report?.families[1]!.top_reasons).toEqual([{ reason: 'auth_failed', count: 3 }]);
  expect(report?.families[2]).toMatchObject({ launches: 4, empty: 1, empty_rate: 0.25 });
});

it('shows unknown as unknown and recuts a half-empty family', async () => {
  const ids = ['RQ-MIXED-1', 'RQ-MIXED-2', 'RQ-MIXED-3', 'RQ-MIXED-4'];
  const report = await readEmptyFamilies(24, '/fixture', now, {
    read: reader(ids.map((id, i) => row(id, 'zai', i < 2)), { 'RQ-MIXED-1.log': 'Worker timed out.', 'RQ-MIXED-2.log': 'Inspection ended.' }),
  });
  expect(report?.families[0]).toMatchObject({ action: 'recut', top_reasons: [{ reason: 'timed out', count: 1 }, { reason: 'unknown', count: 1 }] });
});

it('prints one line per family, JSON with a schema id, and "No empty jobs."', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const readFamilies = async (hours: number) => readEmptyFamilies(hours, '/fixture', now, { read: reader(rows, logs) });
  expect(await cmdJobs(['empty', '--by-family'], undefined, readFamilies)).toBe(0);
  expect(log.mock.calls.map(c => c[0])).toEqual([
    'STOP RQ-MD* (devin-flash): 5 of 5 empty (100%); already-on-master 5',
    'REROUTE RQ-LOGIN* (cursor): 3 of 3 empty (100%); auth_failed 3',
    'KEEP RQ-HEALTHY* (claude): 1 of 4 empty (25%); no-op change 1',
  ]);
  log.mockClear();
  expect(await cmdJobs(['empty', '--by-family', '--since', '24h', '--json'], undefined, readFamilies)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0]).schema).toBe('jobs.empty.by-family.v1');
  log.mockClear();
  const none = async (hours: number) => readEmptyFamilies(hours, '/fixture', now, { read: reader([row('RQ-OK-1', 'claude', false)]) });
  expect(await cmdJobs(['empty', '--by-family'], undefined, none)).toBe(0);
  expect(log.mock.calls).toEqual([['No empty jobs.']]);
  expect(await cmdJobs(['empty', '--by-family', '--lane', 'x'], undefined, none)).toBe(2);
});
