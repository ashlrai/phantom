import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mergeAge, type MergeAgeInput } from '../src/core/fleet/merge-age.js';
import { cmdFleetMergeAge } from '../src/cli/fleet-merge-age.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const now = Date.parse('2026-11-03T12:00:00Z');
const pr = (number: number) => ({ number, mergeable: 'MERGEABLE' as const, reviewDecision: 'APPROVED' as const });
const entry = (number: number, enteredAt = '2026-11-03T11:00:00Z') => ({ number, enteredAt, requiredChecks: [{ name: 'Merge Gate', status: 'success' as const }] });
afterEach(() => vi.restoreAllMocks());

it('orders queue age deterministically and selects the oldest actionable delay', () => {
  const report = mergeAge({ prs: [pr(1), pr(2), { ...pr(3), mergeable: 'CONFLICTING' }, pr(4)],
    queue: [entry(4), entry(2), entry(1, '2026-11-03T10:00:00Z'), entry(3)] }, now);
  expect(report.entries.map(row => row.number)).toEqual([1, 2, 3, 4]);
  expect(report.oldestActionable).toMatchObject({ number: 3, ageSeconds: 3600, causes: [{ code: 'conflicts' }] });
  expect(report.entries[0]!.causes).toEqual([]);
});

it('reports unknown, future, invalid and ambiguous evidence without estimating age', () => {
  const report = mergeAge({ prs: [], queue: [{ number: 1 }, entry(2, 'bad'), entry(3, '2027-01-01'), entry(4), entry(4)] }, now);
  expect(report.entries.find(row => row.number === 1)).toMatchObject({ ageSeconds: null,
    missingData: ['pull_request', 'mergeability', 'review', 'required_checks', 'entered_at'] });
  expect(report.entries.filter(row => row.number < 4).every(row => row.ageSeconds === null)).toBe(true);
  expect(report.entries[0]!.missingData).toContain('unique_queue_entry');
  expect(report.oldestActionable).toBeNull();
  expect(mergeAge({ prs: [], queue: [] }, now).entries).toEqual([]);
});

it('preserves every required check and proposes fixes through the queue without mutating evidence', () => {
  const input: MergeAgeInput = { prs: [{ ...pr(1), reviewDecision: 'CHANGES_REQUESTED' }], queue: [{ ...entry(1),
    requiredChecks: ['failure', 'pending', 'missing', 'success'].map(status => ({ name: `gate-${status}`, status: status as 'failure' })) }] };
  const before = structuredClone(input);
  const report = mergeAge(input, now);
  expect(input).toEqual(before);
  expect(report).toMatchObject({ readOnly: true, requiredChecksPreserved: true });
  expect(report.entries[0]!.requiredChecks).toEqual(input.queue[0]!.requiredChecks);
  expect(report.entries[0]!.causes.map(cause => cause.code)).toEqual(['review', 'check_failure', 'check_pending', 'check_missing']);
});

it('exposes read-only JSON through the registered CLI and rejects malformed snapshots and flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-age-'));
  const path = join(dir, 'snapshot.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const text = JSON.stringify({ prs: [pr(1)], queue: [{ ...entry(1, '2020-01-01T00:00:00Z'), requiredChecks: [{ name: 'Merge Gate', status: 'failure' }] }] });
    await writeFile(path, text);
    expect(await cmdFleetMergeAge(['--input', path, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ readOnly: true, oldestActionable: { number: 1 } });
    expect(await readFile(path, 'utf8')).toBe(text);
    for (const value of ['null', '{}', '{', '{"prs":[],"queue":[{"number":1,"requiredChecks":[{"name":"Gate","status":"skipped"}]}]}']) {
      await writeFile(path, value);
      expect(await cmdFleetMergeAge(['--input', path])).toBe(1);
    }
    expect(await cmdFleetMergeAge(['--input', join(dir, 'missing')])).toBe(1);
    for (const args of [[], ['--json'], ['--input'], ['--admin'], ['--input', path, '--json', '--json']]) expect(await cmdFleetMergeAge(args)).toBe(2);
    expect(await cmdFleetMergeAge(['--help'])).toBe(0);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['merge-age']!()).cmdFleetMergeAge).toBe('function');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
