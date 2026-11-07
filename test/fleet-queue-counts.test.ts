import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueCounts } from '../src/cli/fleet-queue-counts.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { getLaneQueueCounts } from '../src/core/fleet/queue-counts.js';

const NOW = new Date('2026-11-06T12:00:00Z');
const now = () => NOW;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const row = (status: string, id: string, pool: string) => `${status}\t${id}\t${pool}\twork\texample/phantom\tFixture`;
const merge = (job: string, lane: string, ts: string | undefined, url?: string) =>
  JSON.stringify({ job, lane, event: 'outcome', state: 'MERGED', ...(ts ? { ts } : {}), ...(url ? { url } : {}) });

let root: string;
let queueDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'queue-counts-'));
  queueDir = join(root, 'queue');
  await mkdir(queueDir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('counts ready, parked, running and last-hour merges per lane', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin'), row('READY', 'c-1', 'codex'),
    row('PARKED-DEP.devin', 'a-3', 'devin'),
    row('CLAIMED', 'a-4', 'devin'), row('RUNNING', 'c-2', 'codex'),
  ].join('\n'));
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    merge('m-1', 'devin', minutesAgo(10)), merge('m-2', 'devin', minutesAgo(59)),
    merge('m-3', 'devin', minutesAgo(61)), merge('m-4', 'codex', minutesAgo(5)),
  ].join('\n'));
  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.lanes).toEqual([
    { lane: 'codex', ready: 1, parked: 0, running: 1, merges: 1 },
    { lane: 'devin', ready: 2, parked: 1, running: 1, merges: 2 },
  ]);
  expect(report.totals).toEqual({ ready: 3, parked: 1, running: 2, merges: 3 });
});

it('ignores merge events with missing or invalid timestamps', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'a-1', 'devin'));
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    merge('m-1', 'devin', undefined), merge('m-2', 'devin', 'not-a-date'),
    merge('m-3', 'devin', minutesAgo(-30)), merge('m-4', 'devin', minutesAgo(1)),
  ].join('\n'));
  const [devin] = (await getLaneQueueCounts({ runsDir: root, now })).lanes;
  expect(devin).toMatchObject({ lane: 'devin', merges: 1 });
});

it('counts a duplicated merge event once, by PR then by job', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'a-1', 'devin'));
  const pr = 'https://github.com/ashlrai/phantom/pull/42';
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    merge('m-1', 'devin', minutesAgo(9), pr), merge('m-1', 'devin', minutesAgo(8), pr),
    merge('m-1', 'devin', minutesAgo(7)),
    merge('m-2', 'devin', minutesAgo(6)), merge('m-2', 'devin', minutesAgo(5)),
  ].join('\n'));
  const [devin] = (await getLaneQueueCounts({ runsDir: root, now })).lanes;
  expect(devin!.merges).toBe(2);
});

it('reports unknown (null), not zero, when sources are absent', async () => {
  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.lanes).toEqual([]);
  expect(report.totals).toEqual({ ready: 0, parked: 0, running: 0, merges: 0 });
  await writeFile(join(queueDir, 'jobs.jsonl'), merge('m-1', 'devin', minutesAgo(3)));
  const [devin] = (await getLaneQueueCounts({ runsDir: root, now })).lanes;
  expect(devin).toEqual({ lane: 'devin', ready: null, parked: null, running: null, merges: 1 });
});

it('prints text and JSON from the CLI and rejects bad arguments', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'a-1', 'devin'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetQueueCounts(['--root', root])).toBe(0);
  expect(log.mock.calls.map(c => String(c[0]))).toEqual([
    'devin  ready 1  parked 0  running 0  merges/1h -',
    'total  ready 1  parked 0  running 0  merges/1h 0',
  ]);
  expect(await cmdFleetQueueCounts(['--root', root, '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).schema).toBe('fleet.queue-counts.v1');
  expect(await cmdFleetQueueCounts(['--root', 'relative'])).toBe(2);
  expect(await cmdFleetQueueCounts(['--bogus'])).toBe(2);
  expect(err).toHaveBeenCalled();
  expect(FLEET_SUBCOMMAND_LOADERS['queue-counts']).toBeTypeOf('function');
});
