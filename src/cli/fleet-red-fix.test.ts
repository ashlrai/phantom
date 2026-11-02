/** fleet-red-fix.test.ts — flag parsing, text/json output and exit codes of `ashlr fleet red-fix`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedFixOptions, RedFixReport } from '../core/fleet/red-pr-fix-job.js';
import { cmdFleetRedFix } from './fleet-red-fix.js';

const USAGE = 'Usage: ashlr fleet red-fix [--json] [--write] [--hours <1-168>] [--runs-dir <absolute>] [--repo ashlrai/phantom]';

const candidate = (over: Record<string, unknown> = {}) => ({
  number: 2563, jobId: 'RQ-PHX-UNIONPREVIEWFIX02', head: 'a'.repeat(40), run: 91011,
  fixId: 'UNIONPREVIEWFIX02B8D37D259DFIX1', written: false, skipped: null, ...over,
});

const report = (over: Partial<RedFixReport> = {}): RedFixReport => ({
  candidates: [candidate()], reason: null, ...over,
});

let output: string[];
let errors: string;
let run: ReturnType<typeof vi.fn>;
beforeEach(() => {
  output = [];
  errors = '';
  run = vi.fn(async () => report());
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => { errors += `${String(value)}\n`; });
});
afterEach(() => vi.restoreAllMocks());
const deps = () => ({ run: run as unknown as (opts: RedFixOptions) => Promise<RedFixReport> });

describe('fleet red-fix', () => {
  it('prints usage on --help and exits 0', async () => {
    expect(await cmdFleetRedFix(['--help'], deps())).toBe(0);
    expect(output).toEqual([USAGE]);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses --help mixed with other arguments', async () => {
    for (const args of [['--help', '--json'], ['--json', '--help'], ['-h', '--write']]) {
      errors = '';
      output = [];
      expect(await cmdFleetRedFix(args, deps())).toBe(2);
      expect(errors).toBe(`${USAGE}\n`);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['--bogus'],
    ['x'],
    ['--hours'],
    ['--hours', 'abc'],
    ['--hours', '0'],
    ['--hours', '2.5'],
    ['--hours', '169'],
    ['--hours', '-1'],
    ['--hours', '24', '--hours', '48'],
    ['--runs-dir'],
    ['--runs-dir', 'relative/dir'],
    ['--repo'],
    ['--repo', 'not a repo'],
    ['--repo', 'too/many/parts'],
    ['--repo', 'owner/name'], // red-fix is pinned to ashlrai/phantom
    ['--json', '--json'],
    ['--write', '--write'],
  ])('rejects bad args %j with usage on stderr and exit 2', async (...args: string[]) => {
    expect(await cmdFleetRedFix(args, deps())).toBe(2);
    expect(errors).toBe(`${USAGE}\n`);
    expect(run).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it('defaults to a 24h dry run against ashlrai/phantom', async () => {
    expect(await cmdFleetRedFix([], deps())).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith({ repo: 'ashlrai/phantom', hours: 24, write: false, runsDir: undefined });
  });

  it('passes --hours/--write/--runs-dir/--repo through', async () => {
    expect(await cmdFleetRedFix(['--hours', '48', '--write', '--runs-dir', '/tmp/runs', '--repo', 'ashlrai/phantom'], deps())).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith({ repo: 'ashlrai/phantom', hours: 48, write: true, runsDir: '/tmp/runs' });
  });

  it('prints one line per candidate with its status', async () => {
    run.mockResolvedValueOnce(report({
      candidates: [
        candidate(),
        candidate({ number: 2564, jobId: 'RQ-PHX-OTHERJOB01', fixId: 'OTHERJOB01B8D37D259DFIX2', written: true }),
        candidate({ number: 2565, jobId: 'RQ-PHX-THIRDJOB03', fixId: 'THIRDJOB03B8D37D259DFIX1', skipped: 'already-dropped' }),
      ],
    }));
    expect(await cmdFleetRedFix([], deps())).toBe(0);
    expect(output).toEqual([
      '#2563 RQ-PHX-UNIONPREVIEWFIX02B8D37D259DFIX1: dry-run',
      '#2564 RQ-PHX-OTHERJOB01B8D37D259DFIX2: written',
      '#2565 RQ-PHX-THIRDJOB03B8D37D259DFIX1: already-dropped',
    ]);
  });

  it('prints the report as JSON with --json', async () => {
    expect(await cmdFleetRedFix(['--json'], deps())).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual(report());
    expect(errors).toBe('');
  });

  it('reports a degraded read on stderr and exits 1', async () => {
    run.mockResolvedValueOnce(report({ candidates: [], reason: 'open PR list unavailable or incomplete' }));
    expect(await cmdFleetRedFix([], deps())).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toBe('fleet red-fix: open PR list unavailable or incomplete\n');
  });

  it('exits 1 when a candidate was skipped for a non-idempotent reason', async () => {
    run.mockResolvedValueOnce(report({ candidates: [candidate({ skipped: 'queue-full' })] }));
    expect(await cmdFleetRedFix([], deps())).toBe(1);
    expect(output).toEqual(['#2563 RQ-PHX-UNIONPREVIEWFIX02B8D37D259DFIX1: queue-full']);
  });

  it('stays green when every skip is already-dropped', async () => {
    run.mockResolvedValueOnce(report({ candidates: [candidate({ skipped: 'already-dropped' })] }));
    expect(await cmdFleetRedFix([], deps())).toBe(0);
  });

  it('prints no red fleet PRs when there are no candidates', async () => {
    run.mockResolvedValueOnce(report({ candidates: [] }));
    expect(await cmdFleetRedFix([], deps())).toBe(0);
    expect(output).toEqual(['no red fleet PRs']);
    expect(errors).toBe('');
  });

  it('reports a collection failure on stderr and exits 1', async () => {
    run.mockRejectedValueOnce(new Error('gh offline'));
    expect(await cmdFleetRedFix([], deps())).toBe(1);
    expect(errors).toBe('fleet red-fix: collection failed\n');
  });
});
