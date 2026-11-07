import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReassign } from '../src/cli/fleet-reassign.js';
import { ReassignError, type ReassignInput, type ReassignOptions, type ReassignReportV1 } from '../src/core/fleet/runs-reassign.js';

let output: string[];
let errors: string;
beforeEach(() => {
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

const report = (over: Partial<ReassignReportV1> = {}): ReassignReportV1 => ({
  v: 1, generatedAt: '2026-11-01T00:00:00.000Z', applied: false, lane: 'devin',
  moved: [{ id: 'RQ-PHX-FAKEONE01', fromLane: 'codex-personal', toLane: 'devin', fromTier: 'work', toTier: 'work' }],
  skipped: [], verified: null, ...over,
});
const reassign = (result: ReassignReportV1 | Error = report()) =>
  vi.fn(async (_input: ReassignInput, _opts: ReassignOptions) => {
    if (result instanceof Error) throw result;
    return result;
  });

describe('fleet reassign argument parsing', () => {
  it('prints usage on --help and exits 0', async () => {
    expect(await cmdFleetReassign(['--help'], { reassign: reassign() })).toBe(0);
    expect(output[0]).toContain('usage: ashlr fleet reassign');
  });

  it.each([
    { args: [] as string[] },
    { args: ['RQ-PHX-FAKEONE01'] },
    { args: ['--lane', 'devin'] },
    { args: ['RQ-PHX-FAKEONE01', '--from', 'codex-personal', '--lane', 'devin'] },
    { args: ['RQ-PHX-FAKEONE01', 'RQ-PHX-FAKETWO02', '--lane', 'devin'] },
    { args: ['RQ-PHX-FAKEONE01', '--lane', 'devin', '--bogus'] },
    { args: ['RQ-PHX-FAKEONE01', '--lane'] },
    { args: ['RQ-PHX-FAKEONE01', '--lane', 'devin', '--runs-dir', 'relative/path'] },
  ])('exits 2 on bad arguments: $args', async ({ args }) => {
    expect(await cmdFleetReassign(args, { reassign: reassign() })).toBe(2);
    expect(errors).toContain('usage: ashlr fleet reassign');
  });

  it('passes a job-mode input through to the core', async () => {
    const fn = reassign();
    expect(await cmdFleetReassign(['RQ-PHX-FAKEONE01', '--lane', 'devin', '--tier', 'fast', '--reason', 'lane held'], { reassign: fn })).toBe(0);
    expect(fn).toHaveBeenCalledWith(
      { job: 'RQ-PHX-FAKEONE01', lane: 'devin', tier: 'fast', reason: 'lane held', apply: false },
      { changedBy: 'ashlr fleet reassign' },
    );
  });

  it('passes a from-lane apply with --force and --runs-dir through', async () => {
    const fn = reassign(report({ applied: true, verified: true }));
    expect(await cmdFleetReassign(
      ['--from', 'codex-personal', '--lane', 'devin', '--apply', '--force', '--runs-dir', '/tmp/fake-runs'],
      { reassign: fn })).toBe(0);
    expect(fn).toHaveBeenCalledWith(
      { fromLane: 'codex-personal', lane: 'devin', apply: true, force: true },
      { runsDir: '/tmp/fake-runs', changedBy: 'ashlr fleet reassign' },
    );
  });
});

describe('fleet reassign output', () => {
  it('prints the plan and the dry-run hint without --apply', async () => {
    expect(await cmdFleetReassign(['RQ-PHX-FAKEONE01', '--lane', 'devin'], { reassign: reassign() })).toBe(0);
    expect(output[0]).toContain('move RQ-PHX-FAKEONE01  codex-personal/work -> devin/work');
    expect(output[0]).toContain('dry run: add --apply to move 1 job(s)');
  });

  it('prints only the JSON report in --json mode', async () => {
    expect(await cmdFleetReassign(['RQ-PHX-FAKEONE01', '--lane', 'devin', '--json'], { reassign: reassign() })).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual(report());
  });

  it('prints moved lines and skips in human mode after --apply', async () => {
    const applied = report({ applied: true, verified: true, skipped: [{ id: 'RQ-PHX-LAUNCHED9', reason: 'job-launched' }] });
    expect(await cmdFleetReassign(['--from', 'codex-personal', '--lane', 'devin', '--apply'], { reassign: reassign(applied) })).toBe(0);
    expect(output[0]).toContain('moved RQ-PHX-FAKEONE01  codex-personal/work -> devin/work');
    expect(output[0]).toContain('skip RQ-PHX-LAUNCHED9  job-launched');
    expect(output[0]).toContain('verified: ready.tsv holds the 1 reassigned row(s)');
  });

  it('exits 1 and prints the code when the core refuses', async () => {
    const fn = reassign(new ReassignError('lane-held'));
    expect(await cmdFleetReassign(['RQ-PHX-FAKEONE01', '--lane', 'devin'], { reassign: fn })).toBe(1);
    expect(errors).toContain('lane-held');
    expect(output).toEqual([]);
  });

  it('exits 1 when an applied reassign could not be verified', async () => {
    const unverified = report({ applied: true, verified: false, moved: [], skipped: [{ id: 'RQ-PHX-FAKEONE01', reason: 'unverified' }] });
    expect(await cmdFleetReassign(['RQ-PHX-FAKEONE01', '--lane', 'devin', '--apply'], { reassign: reassign(unverified) })).toBe(1);
    expect(output[0]).toContain('NOT verified');
    expect(output[0]).toContain('0 of 1 move(s) confirmed');
  });
});
