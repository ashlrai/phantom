import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueLint, lintQueue } from '../src/cli/fleet-queue-lint.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const fixture = 'test/fixtures/fleet-queue-lint';
afterEach(() => vi.restoreAllMocks());
function output() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, warn };
}
it('reports each fixture line once, in first-missing-field order', async () => {
  const failures = lintQueue(await readFile(join(fixture, 'router-queue.md'), 'utf8'));
  expect(failures.map(row => row.missing)).toEqual(['id', 'priority', 'pool', 'tier', 'repo', 'goal', 'priority']);
  expect(failures[0]).toEqual({ line: 3, id: null, missing: 'id' });
  expect(failures[6]?.id).toBe('RQ-OUTSIDE');
  expect(lintQueue('- READY RQ-NOCOLON (P1, pool=x, tier=work, repo=phantom) goal')[0]?.missing).toBe('goal');
  expect(lintQueue('- READY RQ-OK (P0 FLAGSHIP, pool=x, tier=frontier, repo=phantom): goal\r\n')).toEqual([]);
});
it('reads only the two default paths through injection and prints both counts', async () => {
  const { log, warn } = output();
  const reader = vi.fn((path: string) => readFile(join(fixture, basename(path)), 'utf8'));
  expect(await cmdFleetQueueLint(['--json'], reader)).toBe(1);
  expect(reader.mock.calls.map(call => call[0]).sort()).toEqual(['router-queue.md', 'status.json'].map(file => join(homedir(), '.ashlr-runs', 'queue', file)).sort());
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ total: 7, invalid_queue_lines: 3, readOnly: true });
  expect(warn).toHaveBeenCalledOnce();
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['queue-lint']!()).cmdFleetQueueLint).toBe('function');
});
it('prints plain counts and warns for dispatcher-only invalid lines', async () => {
  const { log, warn } = output();
  expect(await cmdFleetQueueLint([], async path => path.endsWith('.md') ? '' : '{"invalid_queue_lines":2}')).toBe(1);
  expect(log).toHaveBeenCalledWith('Invalid READY lines: 0; dispatcher invalid lines: 2');
  expect(warn).toHaveBeenCalledOnce();
});
it('succeeds for a clean queue and rejects arguments before reading', async () => {
  const { warn } = output();
  const reader = vi.fn(async (path: string) => path.endsWith('.md') ? '' : '{"invalid_queue_lines":0}');
  expect(await cmdFleetQueueLint(['--json'], reader)).toBe(0);
  expect(warn).not.toHaveBeenCalled();
  reader.mockClear();
  for (const args of [['--help'], ['-h'], ['--bad'], ['--json', '--json']]) {
    expect(await cmdFleetQueueLint(args, reader)).toBe(args[0] === '--bad' || args.length > 1 ? 2 : 0);
  }
  expect(reader).not.toHaveBeenCalled();
});
it('preserves available results and reports unavailable inputs without leaking errors', async () => {
  const { log } = output();
  for (const status of ['broken', '{}', '{"invalid_queue_lines":-1}', '{"invalid_queue_lines":1.5}', '{"invalid_queue_lines":"3"}']) {
    expect(await cmdFleetQueueLint(['--json'], async path => path.endsWith('.md') ? '' : status)).toBe(1);
    expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ total: 0, invalid_queue_lines: null });
  }
  expect(await cmdFleetQueueLint(['--json'], async () => { throw new Error('private contents'); })).toBe(1);
  expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ total: null, invalid_queue_lines: null, failures: null });
  expect(JSON.stringify(log.mock.calls)).not.toContain('private contents');
});
