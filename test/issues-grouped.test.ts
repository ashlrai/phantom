import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdIssues } from '../src/cli/issues.js';
import { groupIssues, normalizeError } from '../src/core/queue/issues.js';
import type { QueueJob } from '../src/core/queue/schema.js';
import { QueueStore } from '../src/core/queue/store.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const failed = (id: string, blockedReason?: string): QueueJob => ({
  id, status: 'BLOCKED', priority: 'P1', pool: 'test', tier: 'work', repo: 'phantom', scope: 'fix', acceptance: '', deps: [],
  claims: [{ owner: 'w', claimedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T01:00:00Z' }], ...(blockedReason ? { blockedReason } : {}),
});

// Fixture journal: plain error strings, differing only by ids and times.
const FIXTURE = [
  failed('RQ-A', 'Tests failed in RQ-A at 2026-11-01T00:10:00Z'),
  failed('RQ-B', 'tests failed in RQ-B at 2026-11-02T09:30:15.123Z'),
  failed('RQ-C', 'Tests failed in RQ-C at 2026-11-02 11:00'),
  failed('RQ-D', 'Lint error: unused import (pid 48213)'),
  failed('RQ-E', 'Lint error: unused import (pid 99120)'),
  failed('RQ-F', 'Out of disk space'),
  failed('RQ-G'),
  { ...failed('RQ-OK'), status: 'DONE' as const, blockedReason: undefined },
  { ...failed('RQ-LIVE', 'Tests failed'), status: 'CLAIMED' as const, claims: [{ owner: 'w', claimedAt: '2026-11-02T00:00:00Z' }] },
];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'issues-')); directories.push(dir);
  const store = new QueueStore(dir);
  for (const job of FIXTURE) await store.add(structuredClone(job));
  return { dir, store };
}
const run = async (args: string[]) => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdIssues(args);
  const text = out.mock.calls.map(call => String(call[0])).join('\n');
  out.mockRestore();
  return { code, text };
};

it('strips ids and timestamps so repeats compare equal', () => {
  expect(normalizeError('Failed RQ-X.1 at 2026-11-02T01:02:03Z, run 123e4567-e89b-12d3-a456-426614174000', 'RQ-X.1'))
    .toBe('failed <id> at <time>, run <id>');
  expect(normalizeError('  ')).toBe('(no error text)');
});

it('groups failed jobs with counts and sample ids, biggest first, ignoring non-failed jobs', async () => {
  const { store } = await setup();
  const report = groupIssues(await store.read());
  expect(report.failed).toBe(7);
  expect(report.groups.map(g => [g.error, g.count])).toEqual([
    ['tests failed in <id> at <time>', 3],
    ['lint error: unused import (pid <n>)', 2],
    ['(no error text)', 1],
    ['out of disk space', 1],
  ]);
  expect(report.groups[0]!.samples).toEqual(['RQ-A', 'RQ-B', 'RQ-C']);
});

it('is read-only by default and reports JSON or plain words', async () => {
  const { dir, store } = await setup();
  const before = await readFile(store.path, 'utf8');
  const json = await run(['--dir', dir, '--json']);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.text)).toMatchObject({ v: 1, failed: 7, groups: [{ count: 3, jobs: ['RQ-A', 'RQ-B', 'RQ-C'] }, expect.anything(), expect.anything(), expect.anything()] });
  const plain = await run(['--dir', dir]);
  expect(plain.text).toContain('7 failed jobs, 4 kinds of error.');
  expect(plain.text).toContain('3 x tests failed in <id> at <time>');
  expect(plain.text).toContain('e.g. RQ-A, RQ-B, RQ-C');
  expect(await readFile(store.path, 'utf8')).toBe(before);
});

it('--retry writes one READY retry per failed job and does not duplicate on repeat', async () => {
  const { dir, store } = await setup();
  const first = await run(['--retry', '--dir', dir, '--json']);
  const retried = JSON.parse(first.text).retried as Array<{ id: string; retry: string }>;
  expect(retried.map(r => r.id).sort()).toEqual(['RQ-A', 'RQ-B', 'RQ-C', 'RQ-D', 'RQ-E', 'RQ-F', 'RQ-G']);
  const jobs = (await store.read()).jobs;
  expect(jobs).toHaveLength(FIXTURE.length + 7);
  expect(jobs.filter(job => job.replayOf).every(job => job.status === 'READY')).toBe(true);
  expect((await run(['--retry', '--dir', dir])).text).toBe('Nothing to retry.');
  expect((await store.read()).jobs).toHaveLength(FIXTURE.length + 7);
});

it('reports an empty queue and rejects bad options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'issues-')); directories.push(dir);
  expect((await run(['--dir', dir])).text).toBe('No failed jobs.');
  expect((await run(['--retry', '--dir', dir])).text).toBe('Nothing to retry.');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await run(['--bogus'])).code).toBe(1);
});
