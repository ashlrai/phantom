import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLandedClose, type LandedCloseRunner } from '../src/cli/fleet-landed-close.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const COMMENT = 'Closed by ashlr fleet landed-close: every changed path already matches master at the time of the check.';

const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number, title: `bridge: RQ-PHX-X${number}`, head: SHA_A, base: 'master', class: 'landed',
  changedPaths: ['a.ts', 'b.ts'], landedPaths: ['a.ts', 'b.ts'], remainingPaths: [], ...over,
});
const report = (prs: unknown[]) => JSON.stringify({ schema: 'fleet.dirty-landed.v1', repo: 'ashlrai/phantom', prs });

let dir: string;
let out: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'landed-close-'));
  out = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

function runnerFor(view: (n: string) => string, closeCode = 0) {
  const calls: string[][] = [];
  const runner: LandedCloseRunner = async (_f, args) => {
    calls.push(args);
    if (args[1] === 'view') return { code: 0, stdout: view(args[2]!), stderr: '' };
    return { code: closeCode, stdout: '', stderr: closeCode ? 'boom' : '' };
  };
  return { runner, calls };
}
const open = (head = SHA_A) => JSON.stringify({ headRefOid: head, state: 'OPEN' });
const ledgerPath = () => join(dir, 'queue', 'landed-closes.jsonl');
const run = (args: string[], input: string, runner: LandedCloseRunner) =>
  cmdFleetLandedClose(args, { stdin: async () => input, runner, runsDir: dir, now: () => 0 });

describe('fleet landed-close', () => {
  it('dry run lists only landed bridge PRs and never calls the runner', async () => {
    const { runner, calls } = runnerFor(() => open());
    const input = report([pr(1), pr(2, { title: 'feat: other' }), pr(3, { class: 'partly-landed' }),
      pr(4, { head: 'short' }), pr(5, { changedPaths: [] })]);
    expect(await run([], input, runner)).toBe(0);
    expect(out).toEqual(['#1 bridge: RQ-PHX-X1 -> all 2 paths on master', 'dry run: add --apply to close']);
    expect(calls).toEqual([]);
  });

  it('--apply views then closes and writes a ledger line', async () => {
    const { runner, calls } = runnerFor(() => open());
    expect(await run(['--apply'], report([pr(7)]), runner)).toBe(0);
    expect(calls).toEqual([
      ['pr', 'view', '7', '--repo', 'ashlrai/phantom', '--json', 'headRefOid,state'],
      ['pr', 'close', '7', '--repo', 'ashlrai/phantom', '--comment', COMMENT],
    ]);
    const lines = (await readFile(ledgerPath(), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toEqual([{ at: '1970-01-01T00:00:00.000Z', pr: 7, head: SHA_A, outcome: 'closed' }]);
    expect((await stat(ledgerPath())).mode & 0o777).toBe(0o600);
  });

  it('skips a moved head with head-moved and never closes', async () => {
    const { runner, calls } = runnerFor(() => open(SHA_B));
    expect(await run(['--apply', '--json'], report([pr(8)]), runner)).toBe(0);
    expect(calls.map(c => c[1])).toEqual(['view']);
    const json = JSON.parse(out[0]!);
    expect(json).toMatchObject({ planned: 1, attempted: 1, closed: 0, skipped: 1, failed: 0 });
    expect(json.rows[0]).toMatchObject({ outcome: 'skipped', reason: 'head-moved' });
    expect(await readFile(ledgerPath(), 'utf8')).toContain('"reason":"head-moved"');
  });

  it('skips a PR that is no longer OPEN', async () => {
    const { runner, calls } = runnerFor(() => JSON.stringify({ headRefOid: SHA_A, state: 'MERGED' }));
    expect(await run(['--apply'], report([pr(9)]), runner)).toBe(0);
    expect(calls.map(c => c[1])).toEqual(['view']);
  });

  it('stops at the first failing close and exits 1', async () => {
    const { runner, calls } = runnerFor(() => open(), 1);
    expect(await run(['--apply'], report([pr(1), pr(2)]), runner)).toBe(1);
    expect(calls.map(c => c[1])).toEqual(['view', 'close']);
    expect(await readFile(ledgerPath(), 'utf8')).toContain('"outcome":"failed"');
  });

  it('exits 1 on bad schema or non-array prs', async () => {
    const { runner } = runnerFor(() => open());
    expect(await run([], JSON.stringify({ schema: 'nope', prs: [] }), runner)).toBe(1);
    expect(await run([], JSON.stringify({ schema: 'fleet.dirty-landed.v1', prs: {} }), runner)).toBe(1);
    expect(await run([], 'not json', runner)).toBe(1);
  });

  it('exits 2 on an unknown flag', async () => {
    const { runner } = runnerFor(() => open());
    expect(await run(['--bogus'], report([]), runner)).toBe(2);
  });

  it('reads --from <file>', async () => {
    const { runner } = runnerFor(() => open());
    const file = join(dir, 'report.json');
    await writeFile(file, report([pr(3)]));
    expect(await cmdFleetLandedClose(['--from', file], { runner, runsDir: dir })).toBe(0);
    expect(out[0]).toContain('#3 ');
  });

  it('respects --limit', async () => {
    const { runner, calls } = runnerFor(() => open());
    expect(await run(['--apply', '--limit', '2'], report([pr(1), pr(2), pr(3)]), runner)).toBe(0);
    expect(calls.filter(c => c[1] === 'close').map(c => c[2])).toEqual(['1', '2']);
  });
});
