import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueShape, queueShape } from '../src/cli/fleet-queue-shape.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root: string;
let queueDir: string;
const slot = (target: number, held = false) => ({ target, floor: 0, ceiling: 64, held });
const ready = (id: string, pool: string, repo: string, status = 'READY') =>
  `${status}\t${id}\t${pool}\twork\t${repo}\tFixture job`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'queue-shape-'));
  queueDir = join(root, 'queue');
  await mkdir(queueDir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('prints per-lane depth and blame repos in text mode', async () => {
  const lines = [
    ...Array.from({ length: 8 }, (_, i) => ready(`j-${i}`, 'devin', 'example/side-repo')),
    ...Array.from({ length: 3 }, (_, i) => ready(`p-${i}`, 'devin', 'example/phantom')),
    ready('c-1', 'codex', 'example/phantom'), ready('c-2', 'codex', 'example/phantom'),
    ready('x-1', 'devin', 'example/side-repo', 'CLAIMED'),
  ].join('\n');
  await writeFile(join(queueDir, 'ready.tsv'), lines);
  await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
    devin: slot(3), codex: slot(4), paused: slot(0, true),
  }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetQueueShape(['--queue-dir', queueDir])).toBe(0);
  const out = log.mock.calls.map(call => String(call[0]));
  expect(out[0]).toMatch(/^devin {2}ready 11 \/ target 3 \(3\.7x\) {2}OVER-DEEP {2}top: example\/side-repo 73%, example\/phantom 27%$/);
  expect(out).toContain('codex  ready 2 / target 4 (0.5x)  top: example/phantom 100%');
  expect(out).toContain('paused  ready 0 / target 0 HELD');
});

it('emits the v1 JSON report and honours --factor', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    ...Array.from({ length: 5 }, (_, i) => ready(`j-${i}`, 'devin', 'example/side-repo')),
  ].join('\n'));
  await writeFile(join(queueDir, 'slots.json'), JSON.stringify({ devin: slot(2) }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetQueueShape(['--queue-dir', queueDir, '--json'])).toBe(0);
  const report = JSON.parse(String(log.mock.calls[0]![0]));
  expect(report).toMatchObject({ v: 1, totalReady: 5, totalTarget: 2, overDeep: [] });
  expect(report.lanes).toEqual([
    { lane: 'devin', ready: 5, target: 2, ratio: 2.5, overDeep: false, held: false,
      topRepos: [{ repo: 'example/side-repo', ready: 5, share: 1 }] },
  ]);
  expect(await cmdFleetQueueShape(['--queue-dir', queueDir, '--json', '--factor', '2'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls[1]![0])).overDeep).toEqual(['devin']);
});

it('reports a missing ready.tsv as an empty queue, exit 0', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetQueueShape(['--queue-dir', queueDir])).toBe(0);
  expect(log).toHaveBeenCalledWith('queue: missing (ready.tsv)');
});

it('keeps working when slots.json is absent or corrupt; basenames only', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), ready('j-1', 'devin', 'example/side-repo'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetQueueShape(['--queue-dir', queueDir, '--json'])).toBe(0);
  const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
  expect(report.lanes).toEqual([
    expect.objectContaining({ lane: 'devin', ready: 1, target: null, ratio: null, overDeep: false }),
  ]);
  await writeFile(join(queueDir, 'slots.json'), '{broken');
  expect(await cmdFleetQueueShape(['--queue-dir', queueDir, '--json'])).toBe(0);
  expect(String(log.mock.calls.at(-1)![0])).not.toContain(root);
  // A truncated ready.tsv still parses its good rows; nothing throws.
  await writeFile(join(queueDir, 'ready.tsv'), `READY\tj-1\tdevin\twork\texample/side-repo\n\x00garbage\n`);
  expect(await cmdFleetQueueShape(['--queue-dir', queueDir, '--json'])).toBe(0);
});

it('rejects bad arguments with exit 2 and answers --help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetQueueShape(['--help'])).toBe(0);
  expect(String(log.mock.calls[0]![0])).toContain('Usage: phm fleet queue-shape');
  for (const args of [
    ['--factor'], ['--factor', 'abc'], ['--factor', '0'], ['--factor', '-1'], ['--factor', '1', '--factor', '2'],
    ['--queue-dir', 'relative/path'], ['--queue-dir'], ['--bogus'], ['--json', '--json'],
  ]) expect(await cmdFleetQueueShape(args)).toBe(2);
  expect(err).toHaveBeenCalled();
  // No args reads the default ~/.ashlr-runs/queue (absent under the test home).
  expect(await cmdFleetQueueShape([])).toBe(0);
  expect(log).toHaveBeenCalledWith('queue: missing (ready.tsv)');
});

it('loads through the fleet subcommand registry', async () => {
  const mod = await FLEET_SUBCOMMAND_LOADERS['queue-shape']!();
  expect(typeof mod['cmdFleetQueueShape']).toBe('function');
  expect(mod['queueShape']).toBe(queueShape);
});
