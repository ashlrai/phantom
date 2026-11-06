import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobOne, readJobOne, type JobOneReaders } from '../src/cli/fleet-job-one.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

afterEach(() => vi.restoreAllMocks());
const row = (event: string, minute: number, extra = {}) => ({ job: 'RQ-ONE', event, ts: new Date(Date.UTC(2026, 10, 2, 10, minute)).toISOString(), ...extra });
const readers = (...rows: unknown[]): JobOneReaders => ({ readJobs: async () => rows.map(r => JSON.stringify(r)).join('\n'), readPrompt: async () => 'Do the work.\r\nMore detail.' });

it('joins unordered job events and preserves zero and false values', async () => {
  const deps = readers(row('outcome', 5, { state: 'MERGED' }), row('finish', 2, { diff_files: 0, empty: false, wall_s: 0 }),
    row('publish', 3, { url: 'https://github.com/ashlrai/phantom/pull/12' }), row('launch', 0, { lane: 'codex', model: 'model-one' }),
    row('outcome', 6, { state: 'MERGED' }), row('launch', 9, { job: 'RQ-OTHER' }));
  deps.readPrompt = vi.fn(deps.readPrompt);
  expect(await readJobOne('RQ-ONE', deps)).toEqual({ schema: 'fleet.job-one.v1', job: 'RQ-ONE', lane: 'codex', model: 'model-one',
    launched_at: row('', 0).ts, finish: { at: row('', 2).ts, diff_files: 0, empty: false, wall_s: 0 },
    pr_url: 'https://github.com/ashlrai/phantom/pull/12', merge_state: 'MERGED', merged_at: row('', 5).ts,
    time_to_merge_s: 300, first_prompt_line: 'Do the work.' });
  expect(deps.readPrompt).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs', 'queue', 'prompts', 'RQ-ONE.md'));
});

it('keeps a retry separate from the old finish and merge', async () => {
  expect(await readJobOne('RQ-ONE', readers(row('launch', 0), row('finish', 1, { empty: true }), row('outcome', 2, { state: 'MERGED' }),
    row('launch', 3, { lane: 'new' })))).toMatchObject({ lane: 'new', finish: { empty: 'unknown' }, merge_state: 'unknown', time_to_merge_s: 'unknown' });
});

it('reports unread files independently and never prints their errors', async () => {
  const unread = async (): Promise<string> => { throw new Error('private read failure'); };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetJobOne(['RQ-ONE', '--json'], { readJobs: unread, readPrompt: unread })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ lane: 'unknown', first_prompt_line: 'unknown', finish: { diff_files: 'unknown' } });
  expect(await readJobOne('RQ-ONE', { ...readers(row('launch', 0, { lane: 'codex' })), readPrompt: unread })).toMatchObject({ lane: 'codex', first_prompt_line: 'unknown' });
  await cmdFleetJobOne(['RQ-ONE'], { readJobs: async () => null, readPrompt: async () => '' });
  expect(log.mock.calls.at(-1)![0]).toContain('Lane: unknown');
});

it('ignores malformed rows and invalid fields without inventing measurements', async () => {
  const deps = readers(null, [], row('finish', 2, { diff_files: -1, empty: 'false', wall_s: Infinity }), row('outcome', 3, { state: 'OPEN', url: 'file:///private' }));
  const original = deps.readJobs;
  deps.readJobs = async () => '{broken\n' + await original();
  expect(await readJobOne('RQ-ONE', deps)).toMatchObject({ finish: { diff_files: 'unknown', empty: 'unknown', wall_s: 'unknown' }, pr_url: 'unknown', merge_state: 'OPEN', time_to_merge_s: 'unknown' });
});

it('registers the command and rejects invalid paths and flags before reading', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS['job-one']!()).cmdFleetJobOne).toBe(cmdFleetJobOne);
  const deps = { readJobs: vi.fn(async () => ''), readPrompt: vi.fn(async () => '') };
  for (const args of [[], ['../private'], ['RQ-ONE', '--write'], ['RQ-ONE', '--json', '--json']]) expect(await cmdFleetJobOne(args, deps)).toBe(2);
  expect(await cmdFleetJobOne(['--help'], deps)).toBe(0);
  expect(deps.readJobs).not.toHaveBeenCalled();
  expect(deps.readPrompt).not.toHaveBeenCalled();
  await expect(readJobOne('../private', deps)).rejects.toThrow('Invalid job id');
});
