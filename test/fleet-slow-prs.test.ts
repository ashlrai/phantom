import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSlowPrs, summarizeFleetSlowPrs } from '../src/cli/fleet-slow-prs.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

afterEach(() => vi.restoreAllMocks());
const url = (n: number, repo = 'ashlrai/phantom') => `https://github.com/${repo}/pull/${n}`;
const row = (n: number, minute: number, fields = {}) => JSON.stringify({ url: url(n), ts: new Date(Date.UTC(2026, 10, 4, 0, minute)).toISOString(), ...fields });
const report = (lines: string[]) => summarizeFleetSlowPrs(lines.join('\n'));

it('uses first opening, dedupes URLs, and includes the exact 30 minute boundary', () => {
  expect(report([row(1, 0, { class: 'pr' }), row(1, 20, { class: 'pr' }), row(2, 1, { class: 'pr' }), row(3, 30)]).repos)
    .toEqual([{ repo: 'ashlrai/phantom', count: 1, urls: [url(1)] }]);
});
it('uses newest outcome by timestamp, including reopenings and out of order rows', () => {
  expect(report([
    ...[1, 2, 3, 4].map(n => row(n, 0, { class: 'pr' })),
    row(1, 35, { event: 'outcome', state: 'MERGED' }), row(1, 20, { event: 'outcome', state: 'OPEN' }),
    row(2, 30, { event: 'outcome', state: 'CLOSED' }),
    row(3, 35, { event: 'outcome', state: 'OPEN' }), row(3, 20, { event: 'outcome', state: 'CLOSED' }),
    row(4, 35, { event: 'outcome', state: 'UNKNOWN' }),
  ]).repos[0]?.urls).toEqual([url(3)]);
});
it('ignores malformed rows and unsafe URLs and does not invent opening timestamps', () => {
  expect(report(['null', '[]', '{', row(1, 0, { class: 'pr', ts: 'bad' }), row(1, 0, { class: 'pr' }),
    row(2, 0, { class: 'pr', url: 'https://evil.example/pull/2' }), row(3, 90)]).repos).toEqual([]);
});
it('takes only the final 3000 lines, with a trailing newline', () => {
  expect(report([row(1, 0, { class: 'pr' }), ...Array<string>(2999).fill('{}'), row(2, 90) + '\n']).repos).toEqual([]);
});
it('groups repositories in stable order and supports timezone offsets', () => {
  const result = report([row(1, 0, { class: 'pr', url: url(1, 'z/repo'), ts: '2026-11-03T19:00:00-0500' }),
    row(2, 0, { class: 'pr', url: url(2, 'a/repo') }), row(3, 30)]);
  expect(result.repos.map(g => g.repo)).toEqual(['a/repo', 'z/repo']);
});
it('prints plain lines or typed JSON through a single injected reader', async () => {
  const reader = vi.fn(async (_path: string) => [row(1, 0, { class: 'pr' }), row(2, 30)].join('\n'));
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetSlowPrs([], reader)).toBe(0);
  expect(reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'));
  expect(out).toHaveBeenLastCalledWith(`ashlrai/phantom 1 ${url(1)}`);
  expect(await cmdFleetSlowPrs(['--json'], reader)).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual(summarizeFleetSlowPrs(await reader('')));
});
it('handles empty and unreadable ledgers without exposing error details', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetSlowPrs([], async () => '')).toBe(0);
  expect(out).toHaveBeenLastCalledWith('No slow PRs.');
  expect(await cmdFleetSlowPrs(['--json'], async () => { throw new Error('private detail'); })).toBe(2);
  expect(String(out.mock.calls.at(-1)?.[0])).not.toContain('private detail');
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0])).error).toBe('Jobs ledger is unreadable.');
});
it('registers the command and validates arguments before reading', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const reader = vi.fn(async () => '');
  expect(await cmdFleetSlowPrs(['--help'], reader)).toBe(0);
  for (const args of [['--bad'], ['--json', '--json']]) expect(await cmdFleetSlowPrs(args, reader)).toBe(2);
  expect(reader).not.toHaveBeenCalled();
  expect((await FLEET_SUBCOMMAND_LOADERS['slow-prs']!()).cmdFleetSlowPrs).toBe(cmdFleetSlowPrs);
});
