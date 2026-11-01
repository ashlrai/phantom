/** fleet-red-fix.test.ts — flag parsing, text/json output and exit codes of `ashlr fleet red-fix`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedPrFixReportV1 } from '../core/fleet/red-pr-fix-job.js';
import { cmdFleetRedFix, type FleetRedFixDeps } from './fleet-red-fix.js';

const USAGE = 'Usage: ashlr fleet red-fix [--json] [--hours <n>] [--write] [--runs-dir <abs>] [--repo <owner/name>]';

const candidate = (over: Record<string, unknown> = {}) => ({
  number: 2563, jobId: 'RQ-PHX-UNIONPREVIEWFIX02', headSha: 'a'.repeat(40),
  fixId: 'UNIONPREVIEWFIX02FIX1', written: false, skipped: null, ...over,
});

const report = (over: Partial<RedPrFixReportV1> = {}): RedPrFixReportV1 => ({
  v: 1, generatedAt: '2026-11-01T12:00:00.000Z', repo: 'ashlrai/phantom',
  candidates: [candidate()], queueFull: false, reason: null, ...over,
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
const deps = (): FleetRedFixDeps => ({ run: run as unknown as FleetRedFixDeps['run'] });

describe('fleet red-fix', () => {
  it('prints usage on --help and exits 0', async () => {
    expect(await cmdFleetRedFix(['--help'], deps())).toBe(0);
    expect(output).toEqual([USAGE]);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['--bogus'],
    ['x'],
    ['--hours'],
    ['--hours', 'abc'],
    ['--hours', '0'],
    ['--hours', '2.5'],
    ['--hours', '169'],
    ['--hours', '24', '--hours', '48'],
    ['--runs-dir'],
    ['--runs-dir', 'relative/dir'],
    ['--repo'],
    ['--repo', 'not a repo'],
    ['--repo', 'too/many/parts'],
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
    expect(run).toHaveBeenCalledExactlyOnceWith({ repo: 'ashlrai/phantom', hours: 24, write: false });
  });

  it('passes --hours/--write/--runs-dir/--repo through', async () => {
    expect(await cmdFleetRedFix(['--hours', '48', '--write', '--runs-dir', '/tmp/runs', '--repo', 'owner/name'], deps())).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith({ repo: 'owner/name', hours: 48, write: true, runsDir: '/tmp/runs' });
  });

  it('prints one line per candidate with its status', async () => {
    run.mockResolvedValueOnce(report({
      candidates: [
        candidate(),
        candidate({ number: 2564, jobId: 'RQ-PHX-OTHERJOB01', fixId: 'OTHERJOB01FIX2', written: true }),
        candidate({ number: 2565, jobId: 'RQ-PHX-THIRDJOB03', fixId: 'THIRDJOB03FIX1', skipped: 'already-dropped' }),
      ],
    }));
    expect(await cmdFleetRedFix([], deps())).toBe(0);
    expect(output).toEqual([
      '#2563 RQ-PHX-UNIONPREVIEWFIX02 code-failure -> RQ-PHX-UNIONPREVIEWFIX02FIX1 (dry-run)',
      '#2564 RQ-PHX-OTHERJOB01 code-failure -> RQ-PHX-OTHERJOB01FIX2 (written)',
      '#2565 RQ-PHX-THIRDJOB03 code-failure -> RQ-PHX-THIRDJOB03FIX1 (skipped: already-dropped)',
    ]);
  });

  it('prints the report as JSON with --json', async () => {
    expect(await cmdFleetRedFix(['--json'], deps())).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual(report());
    expect(errors).toBe('');
  });

  it('reports a degraded read on stderr and still exits 0', async () => {
    run.mockResolvedValueOnce(report({ candidates: [], reason: 'open PR list unavailable' }));
    expect(await cmdFleetRedFix([], deps())).toBe(0);
    expect(output).toEqual(['no red fleet PRs']);
    expect(errors).toBe('fleet red-fix: open PR list unavailable\n');
  });

  it('prints no red fleet PRs when there are no candidates', async () => {
    run.mockResolvedValueOnce(report({ candidates: [] }));
    expect(await cmdFleetRedFix([], deps())).toBe(0);
    expect(output).toEqual(['no red fleet PRs']);
    expect(errors).toBe('');
  });
});
