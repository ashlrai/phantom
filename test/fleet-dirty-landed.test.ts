import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDirtyLanded, classifyDirtyLanded, type DirtyLandedReport, type FleetDirtyLandedDeps } from '../src/cli/fleet-dirty-landed.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const row = (number: number, headRefOid: string, mergeStateStatus = 'DIRTY', title = `pr ${number}`) => ({
  number, title, mergeable: mergeStateStatus === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE',
  mergeStateStatus, headRefOid, baseRefName: 'master',
});

let output: string[];
let errors: string;
const dirs: string[] = [];
beforeEach(() => {
  output = []; errors = '';
  // Keep the local Git fixtures independent of an operator's Secrets CLI:
  // `git fetch` is credential-capable, so the runner wraps it in
  // `phantom exec` whenever a phantom binary is on PATH; strip it here.
  const gitPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim();
  vi.stubEnv('PATH', [dirname(gitPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter));
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => { errors += `${String(value)}\n`; });
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A local repo standing in for GitHub: master moved after three topic
 * branches, and refs/pull/N/head name each branch's head. PR 1's change was
 * committed on master too (landed); PR 2 changed two paths and only one
 * landed (partly-landed); PR 3's path still differs (needs-recut). PR 4 pins
 * a head that moved, PR 5 has no pull ref (fetch-failed) and PR 6's row
 * carries no head sha (row-unreadable); PR 7 is CLEAN and skipped.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dirty-landed-')); dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, f), `${f}: orig\n`);
  git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'topic1'); writeFileSync(join(dir, 'a.txt'), 'a.txt: shipped\n'); git('commit', '-qam', 't1');
  const t1 = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'master'); git('checkout', '-qb', 'topic2');
  writeFileSync(join(dir, 'a.txt'), 'a.txt: shipped\n'); writeFileSync(join(dir, 'b.txt'), 'b.txt: new\n');
  git('commit', '-qam', 't2'); const t2 = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'master'); git('checkout', '-qb', 'topic3');
  writeFileSync(join(dir, 'c.txt'), 'c.txt: new\n'); git('commit', '-qam', 't3'); const t3 = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'master');
  writeFileSync(join(dir, 'a.txt'), 'a.txt: shipped\n'); writeFileSync(join(dir, 'c.txt'), 'c.txt: other\n');
  git('commit', '-qam', 'master moves');
  for (const [n, sha] of [[1, t1], [2, t2], [3, t3], [4, t1]] as const) git('update-ref', `refs/pull/${n}/head`, sha);
  return { dir, t1, t2, t3 };
}

function ghReturning(rows: unknown[]): NonNullable<FleetDirtyLandedDeps['gh']> {
  return vi.fn(async () => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' }));
}

describe('classifyDirtyLanded', () => {
  it('classifies all three classes from changed paths vs the differing set', () => {
    expect(classifyDirtyLanded([], new Set())).toBe('landed');
    expect(classifyDirtyLanded(['a'], new Set())).toBe('landed');
    expect(classifyDirtyLanded(['a', 'b'], new Set(['b']))).toBe('partly-landed');
    expect(classifyDirtyLanded(['a', 'b'], new Set(['a', 'b']))).toBe('needs-recut');
    // A path that differs but was never changed by the PR does not count.
    expect(classifyDirtyLanded(['a'], new Set(['z']))).toBe('landed');
  });
});

describe('fleet dirty-landed', () => {
  it('classifies landed, partly-landed, needs-recut and unknown per dirty PR', async () => {
    const { dir, t1, t2, t3 } = fixture();
    const gh = ghReturning([
      row(1, t1), row(2, t2), row(3, t3), row(4, t3), row(5, t1), row(6, ''), row(7, t1, 'CLEAN'),
    ]);
    expect(await cmdFleetDirtyLanded(['--json'], { gh, remote: dir })).toBe(0);
    const report = JSON.parse(output[0]!) as DirtyLandedReport;
    expect(report.schema).toBe('fleet.dirty-landed.v1');
    expect(report).toMatchObject({ open: 7, dirty: 6, complete: true });
    expect(report.counts).toEqual({ landed: 1, 'partly-landed': 1, 'needs-recut': 1, unknown: 3 });
    expect(report.prs.map(pr => [pr.number, pr.class])).toEqual([
      [1, 'landed'], [2, 'partly-landed'], [3, 'needs-recut'],
      [4, 'unknown'], [5, 'unknown'], [6, 'unknown'],
    ]);
    expect(report.prs[0]).toMatchObject({ changedPaths: ['a.txt'], landedPaths: ['a.txt'], remainingPaths: [] });
    expect(report.prs[1]).toMatchObject({ landedPaths: ['a.txt'], remainingPaths: ['b.txt'] });
    expect(report.prs[2]).toMatchObject({ landedPaths: [], remainingPaths: ['c.txt'] });
    expect(report.prs[3]).toMatchObject({ reason: 'head-moved' });
    expect(report.prs[4]).toMatchObject({ reason: 'fetch-failed' });
    expect(report.prs[5]).toMatchObject({ reason: 'row-unreadable' });
  });

  it('prints one plain line per dirty PR in human mode', async () => {
    const { dir, t1, t3 } = fixture();
    const gh = ghReturning([row(1, t1), row(3, t3), row(7, t1, 'CLEAN')]);
    expect(await cmdFleetDirtyLanded([], { gh, remote: dir })).toBe(0);
    expect(output[0]).toContain('2 conflicting open PR(s) — 1 landed, 0 partly-landed, 1 needs-recut, 0 unknown');
    expect(output[1]).toMatch(/^#1 landed: all 1 changed path\(s\) already on master/);
    expect(output[2]).toMatch(/^#3 needs-recut: 1 changed path\(s\) still differ from master/);
    expect(output).toHaveLength(3);
  });

  it.each(['failed', 'not-json', 'not-array'] as const)('exits 1 on %s list reads', async failure => {
    const gh: NonNullable<FleetDirtyLandedDeps['gh']> = async () => ({
      ok: failure !== 'failed', stdout: failure === 'not-json' ? 'nope' : failure === 'not-array' ? '{}' : '', stderr: '',
    });
    expect(await cmdFleetDirtyLanded(['--json'], { gh })).toBe(1);
    expect(output).toEqual([]);
  });

  it('exits 1 on an unreadable PR row and 2 on bad arguments', async () => {
    const gh = ghReturning([{ number: 1 }]);
    expect(await cmdFleetDirtyLanded(['--json'], { gh })).toBe(1);
    expect(errors).toContain('unreadable PR row');
    expect(await cmdFleetDirtyLanded(['--nope'], { gh })).toBe(2);
    expect(await cmdFleetDirtyLanded(['--limit', '0'], { gh })).toBe(2);
    expect(await cmdFleetDirtyLanded(['--help'], { gh })).toBe(0);
    expect(output.at(-1)).toContain('Usage: ashlr fleet dirty-landed');
  });

  it('never spawns git or gh when no open PR conflicts', async () => {
    const gh = ghReturning([row(7, 'a'.repeat(40), 'CLEAN')]);
    expect(await cmdFleetDirtyLanded(['--json'], { gh })).toBe(0);
    const report = JSON.parse(output[0]!) as DirtyLandedReport;
    expect(report).toMatchObject({ open: 1, dirty: 0, prs: [] });
    expect(report.counts).toEqual({ landed: 0, 'partly-landed': 0, 'needs-recut': 0, unknown: 0 });
  });

  it('resolves through the fleet subcommand registry', async () => {
    const resolved = resolveFleetSubcommand('dirty-landed');
    expect(resolved).toEqual({ module: './fleet-dirty-landed.js', exportName: 'cmdFleetDirtyLanded' });
    const loader = FLEET_SUBCOMMAND_LOADERS['dirty-landed'];
    expect(typeof (await loader!())[resolved!.exportName]).toBe('function');
  });
});
