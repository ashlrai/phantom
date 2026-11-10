import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMergeQueueAge, mergeQueueAge, type MergeQueueAgeInput } from '../src/cli/fleet-merge-queue-age.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const sha = 'a'.repeat(40);
const at = (h: number) => `2026-11-03T${String(h).padStart(2, '0')}:00:00Z`;
const snapshot: MergeQueueAgeInput = {
  prs: [1, 2, 3].map(number => ({ number, state: number === 3 ? 'MERGED' : 'OPEN',
    mergeable: 'MERGEABLE', reviewDecision: 'APPROVED' })),
  queue: [1, 2, 3].map(number => ({ number, enteredAt: at(9 - number),
    requiredChecks: [{ name: 'Merge Gate', status: number === 2 ? 'failure' : 'success' }] })),
};
afterEach(() => vi.restoreAllMocks());

it('ranks active queued PRs oldest first and preserves required checks without changing input', () => {
  const before = structuredClone(snapshot);
  const report = mergeQueueAge(snapshot, now);
  expect(report.entries.map(row => [row.number, row.ageSeconds])).toEqual([[2, 18000], [1, 14400]]);
  expect(report.entries[0]).toMatchObject({ causes: [{ code: 'check_failure', since: at(7) }],
    requiredChecks: [{ name: 'Merge Gate', status: 'failure' }] });
  expect(report.entries[1]!.causes).toEqual([]);
  expect(report).toMatchObject({ readOnly: true, requiredChecksPreserved: true, oldestActionable: { number: 2 },
    retryable_conflicts: [], blocked_conflicts: [] });
  expect(snapshot).toEqual(before);
});

it('excludes merged and closed PRs and leaves missing or future evidence unknown', () => {
  expect(mergeQueueAge({ prs: [{ number: 1, state: 'MERGED' }, { number: 2, state: 'CLOSED' }],
    queue: [{ number: 1 }, { number: 2 }] }, now).entries).toEqual([]);
  const report = mergeQueueAge({ prs: [], queue: [{ number: 1 }, { number: 2, enteredAt: '2099-01-01' }] }, now);
  expect(report.entries.every(row => row.ageSeconds === null && row.missingData.includes('required_checks'))).toBe(true);
  expect(report.entries.every(row => row.causes.every(cause => cause.since === null))).toBe(true);
  expect(report.oldestActionable).toBeNull();
});

it('classifies pending checks, conflicts and stale branches with their evidence timestamps', () => {
  const report = mergeQueueAge({ repo: 'ashlrai/phantom',
    prs: [
      { number: 1, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED',
        mergeStateStatus: 'BEHIND', updatedAt: at(10) },
      { number: 2, state: 'OPEN', mergeable: 'CONFLICTING', reviewDecision: 'APPROVED',
        mergeStateStatus: 'DIRTY', updatedAt: at(11), headSha: sha },
    ],
    queue: [
      { number: 1, enteredAt: at(8), requiredChecks: [{ name: 'Merge Gate', status: 'pending' }] },
      { number: 2, enteredAt: at(7), requiredChecks: [
        { name: 'Merge Gate', status: 'failure', at: at(11) }, { name: 'Lint', status: 'pending' }] },
    ] }, now);
  const by = Object.fromEntries(report.entries.map(row => [row.number, row]));
  expect(by[1]!.causes).toEqual([
    { code: 'stale', since: at(10), action: 'Update the branch against its base; required checks run again on the new head.' },
    { code: 'check_pending', since: at(8), action: 'Inspect required check Merge Gate and its merge-group workflow.' }]);
  expect(by[2]!.causes).toEqual([
    { code: 'conflicts', since: at(11), action: 'Resolve conflicts and let required checks run again.' },
    { code: 'check_failure', since: at(11), action: 'Fix required check Merge Gate; rerun it through the merge queue.' },
    { code: 'check_pending', since: at(7), action: 'Inspect required check Lint and its merge-group workflow.' }]);
  // A DIRTY mergeStateStatus alone is mergeability evidence and a conflict.
  const dirty = mergeQueueAge({ prs: [{ number: 4, state: 'OPEN', mergeStateStatus: 'DIRTY' }],
    queue: [{ number: 4, enteredAt: at(9), requiredChecks: [{ name: 'Gate', status: 'success' }] }] }, now);
  expect(dirty.entries[0]!.causes.map(cause => cause.code)).toEqual(['conflicts']);
  expect(dirty.entries[0]!.missingData).not.toContain('mergeability');
  expect(dirty.blocked_conflicts).toEqual([{ number: 4, reason: 'no-repo' }]);
});

it('enqueues one idempotent recut per conflicting head through the existing path', () => {
  const observe = (prExtra: object = {}, input: object = {}) => mergeQueueAge({
    prs: [{ number: 2, state: 'OPEN', mergeable: 'CONFLICTING', headSha: sha,
      repo: 'ashlrai/phantom', updatedAt: at(11), ...prExtra }],
    queue: [{ number: 2, enteredAt: at(7), requiredChecks: [{ name: 'Merge Gate', status: 'pending' }] }],
    ...input }, now);
  const first = observe();
  expect(first.retryable_conflicts).toEqual([{ number: 2, repo: 'ashlrai/phantom', head_sha: sha,
    waiting_s: 18000, since: at(11),
    recut: { key: 'RQ-RECUT-phantom-2-aaaaaaa', repo: 'ashlrai/phantom', number: 2, headSha: sha } }]);
  expect(first.blocked_conflicts).toEqual([]);
  expect(first.requiredChecksPreserved).toBe(true);
  // Re-observing the same head mints the same key — the path dedupes and never enqueues twice.
  expect(observe().retryable_conflicts).toEqual(first.retryable_conflicts);
  // A snapshot-level repo covers a PR that does not name one.
  expect(observe({ repo: undefined }, { repo: 'ashlrai/phantom' }).retryable_conflicts[0]!.repo).toBe('ashlrai/phantom');
  const blocked = (extra: object, input: object = {}) => observe(extra, input).blocked_conflicts;
  expect(blocked({ lastRecutHead: 'aaaaaaa' })).toEqual([{ number: 2, reason: 'already-requested' }]);
  expect(blocked({ lastRecutHead: 'bbbbbbb' })).toEqual([]);
  expect(blocked({ recutRequests: 3 })).toEqual([{ number: 2, reason: 'too-many-recuts' }]);
  expect(blocked({ headSha: 'not-a-sha' })).toEqual([{ number: 2, reason: 'no-head' }]);
  expect(blocked({ repo: undefined })).toEqual([{ number: 2, reason: 'no-repo' }]);
  expect(observe({ lastRecutHead: 'aaaaaaa' }).retryable_conflicts).toEqual([]);
  // A merged or closed conflicting PR leaves the queue and enqueues nothing.
  expect(observe({ state: 'MERGED' }).retryable_conflicts).toEqual([]);
  expect(observe({ state: 'MERGED' }).blocked_conflicts).toEqual([]);
});

it('reports an ambiguous conflict once instead of enqueueing it', () => {
  const report = mergeQueueAge({
    prs: [{ number: 2, state: 'OPEN', mergeable: 'CONFLICTING', headSha: sha, repo: 'ashlrai/phantom' }],
    queue: [{ number: 2, enteredAt: at(7) }, { number: 2, enteredAt: at(8) }] }, now);
  expect(report.retryable_conflicts).toEqual([]);
  expect(report.blocked_conflicts).toEqual([{ number: 2, reason: 'ambiguous' }]);
  const twoPrs = mergeQueueAge({
    prs: [0, 1].map(() => ({ number: 2, state: 'OPEN' as const, mergeable: 'CONFLICTING' as const, headSha: sha, repo: 'ashlrai/phantom' })),
    queue: [{ number: 2, enteredAt: at(7) }] }, now);
  expect(twoPrs.blocked_conflicts).toEqual([{ number: 2, reason: 'ambiguous' }]);
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
    const conflictedSnapshot: MergeQueueAgeInput = { repo: 'ashlrai/phantom',
      prs: [{ number: 2, state: 'OPEN', mergeable: 'CONFLICTING', headSha: sha },
        { number: 3, state: 'OPEN', mergeable: 'CONFLICTING' }],
      queue: [{ number: 2, enteredAt: at(7), requiredChecks: [{ name: 'Merge Gate', status: 'failure' }] },
        { number: 3, enteredAt: at(8), requiredChecks: [{ name: 'Merge Gate', status: 'success' }] }] };
    await writeFile(path, JSON.stringify(conflictedSnapshot));
    expect(await cmdFleetMergeQueueAge(['--input', path])).toBe(0);
    expect(log.mock.calls[1]![0]).toContain('#2\t18000s queued\tResolve conflicts');
    expect(log.mock.calls[2]![0]).toContain('#3\t14400s queued');
    expect(log.mock.calls[3]![0]).toBe('Conflicts the recut loop can retry: #2 (RQ-RECUT-phantom-2-aaaaaaa)');
    expect(log.mock.calls[4]![0]).toBe('Needs a person: #3 (no-head)');
    await writeFile(path, text);
    expect(await readFile(path, 'utf8')).toBe(text);
    for (const text of ['null', '{', '{}', '{"prs":[{"number":1,"state":"invalid"}],"queue":[]}',
      '{"prs":[],"queue":[{"number":1,"requiredChecks":[{"name":"Gate","status":"skipped"}]}]}',
      '{"prs":[{"number":1,"mergeStateStatus":5}],"queue":[]}',
      '{"prs":[{"number":1,"repo":"noslash"}],"queue":[]}',
      '{"prs":[{"number":1,"recutRequests":-1}],"queue":[]}',
      '{"prs":[],"queue":[{"number":1,"requiredChecks":[{"name":"Gate","status":"pending","at":3}]}]}',
      '{"repo":"noslash","prs":[],"queue":[]}']) {
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
