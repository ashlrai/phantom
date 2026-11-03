import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMergeQueueAge, mergeQueueAge, type MergeQueueAgeInput } from '../src/cli/fleet-merge-queue-age.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const snapshot: MergeQueueAgeInput = {
  prs: [1, 2, 3].map(number => ({ number, state: number === 3 ? 'MERGED' : 'OPEN',
    mergeable: 'MERGEABLE', reviewDecision: 'APPROVED' })),
  queue: [1, 2, 3].map(number => ({ number, enteredAt: `2026-11-03T0${9 - number}:00:00Z`,
    requiredChecks: [{ name: 'Merge Gate', status: number === 2 ? 'failure' : 'success' }] })),
};
afterEach(() => vi.restoreAllMocks());

it('ranks active queued PRs oldest first and preserves required checks without changing input', () => {
  const before = structuredClone(snapshot);
  const report = mergeQueueAge(snapshot, now);
  expect(report.entries.map(row => [row.number, row.ageSeconds])).toEqual([[2, 18000], [1, 14400]]);
  expect(report.entries[0]).toMatchObject({ causes: [{ code: 'check_failure' }],
    requiredChecks: [{ name: 'Merge Gate', status: 'failure' }] });
  expect(report.entries[1]!.causes).toEqual([]);
  expect(report).toMatchObject({ readOnly: true, requiredChecksPreserved: true, oldestActionable: { number: 2 } });
  expect(snapshot).toEqual(before);
});

it('excludes merged and closed PRs and leaves missing or future evidence unknown', () => {
  expect(mergeQueueAge({ prs: [{ number: 1, state: 'MERGED' }, { number: 2, state: 'CLOSED' }],
    queue: [{ number: 1 }, { number: 2 }] }, now).entries).toEqual([]);
  const report = mergeQueueAge({ prs: [], queue: [{ number: 1 }, { number: 2, enteredAt: '2099-01-01' }] }, now);
  expect(report.entries.every(row => row.ageSeconds === null && row.missingData.includes('required_checks'))).toBe(true);
  expect(report.oldestActionable).toBeNull();
});

it('offers registered JSON and plain output, validates snapshots and flags, and never writes its input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-queue-age-'));
  const path = join(dir, 'snapshot.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const text = JSON.stringify(snapshot);
    await writeFile(path, text);
    expect(await cmdFleetMergeQueueAge(['--input', path, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(mergeQueueAge(snapshot, now));
    expect(await cmdFleetMergeQueueAge(['--input', path])).toBe(0);
    expect(log.mock.calls[1]![0]).toContain('#2\t18000s queued\tFix required check Merge Gate');
    expect(await readFile(path, 'utf8')).toBe(text);
    for (const text of ['null', '{', '{}', '{"prs":[{"number":1,"state":"invalid"}],"queue":[]}',
      '{"prs":[],"queue":[{"number":1,"requiredChecks":[{"name":"Gate","status":"skipped"}]}]}']) {
      await writeFile(path, text);
      expect(await cmdFleetMergeQueueAge(['--input', path])).toBe(1);
    }
    await writeFile(path, '{"prs":[],"queue":[]}');
    expect(await cmdFleetMergeQueueAge(['--input', path])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toBe('No queued PRs.');
    expect(await cmdFleetMergeQueueAge(['--input', join(dir, 'missing')])).toBe(1);
    for (const args of [[], ['--input'], ['--admin'], ['--json', '--json'], ['--input', path, '--input', path]]) {
      expect(await cmdFleetMergeQueueAge(args)).toBe(2);
    }
    expect(await cmdFleetMergeQueueAge(['--help'])).toBe(0);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['merge-queue-age']!()).cmdFleetMergeQueueAge).toBe('function');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
