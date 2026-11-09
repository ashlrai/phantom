import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDirtyLanded, classifyDirtyLanded, type DirtyLandedReport, type FleetDirtyLandedDeps } from '../src/cli/fleet-dirty-landed.js';
import { recutDropJob } from '../src/core/fleet/recut-drop-body.js';
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
  writeFileSync(join(dir, 'base-only.txt'), 'new base history\n');
  git('add', '.'); git('commit', '-qm', 'master moves');
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
    expect(report.prs[2]).toMatchObject({ changedPaths: ['c.txt'], landedPaths: [], remainingPaths: ['c.txt'] });
    const job = recutDropJob({ ...report.prs[2]!, title: 'bridge: RQ-PHX-EXAMPLE' }, Date.now());
    expect(job).toHaveProperty('body');
    if ('body' in job) {
      expect(job.body).toContain('git diff <merge-base>');
      expect(job.body).not.toContain('base-only.txt');
      expect(job.body).toContain('- "c.txt"');
    }
    expect(report.prs[3]).toMatchObject({ reason: 'head-moved' });
    expect(report.prs[4]).toMatchObject({ reason: 'fetch-failed' });
    expect(report.prs[5]).toMatchObject({ reason: 'row-unreadable' });
  });

  it('refuses a criss-cross history with more than one merge base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ambiguous-fork-')); dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'master');
    git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'file'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    const root = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const a = git('commit-tree', tree, '-p', root, '-m', 'a');
    const b = git('commit-tree', tree, '-p', root, '-m', 'b');
    const base = git('commit-tree', tree, '-p', a, '-p', b, '-m', 'base merge');
    const head = git('commit-tree', tree, '-p', b, '-p', a, '-m', 'head merge');
    git('update-ref', 'refs/heads/master', base); git('update-ref', 'refs/pull/1/head', head);
    expect(await cmdFleetDirtyLanded(['--json'], { gh: ghReturning([row(1, head)]), remote: dir })).toBe(0);
    const report = JSON.parse(output[0]!) as DirtyLandedReport;
    expect(report.prs[0]).toMatchObject({ class: 'unknown', reason: 'ambiguous-merge-base', changedPaths: [] });
  });

  it('reports wide mode and generated zero-line diffs while retaining real large diffs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wide-diff-')); dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'master');
    git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    mkdirSync(join(dir, 'files')); mkdirSync(join(dir, 'generated'));
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, 'files', `${i}.txt`), 'original\n');
    git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'modes');
    for (let i = 0; i < 1000; i++) chmodSync(join(dir, 'files', `${i}.txt`), 0o755);
    git('add', '.');
    git('commit', '-qm', 'modes'); const modes = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'master'); git('checkout', '-qb', 'generated');
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, 'generated', `${i}.txt`), '');
    git('add', '.'); git('commit', '-qm', 'generated'); const generated = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'master'); git('checkout', '-qb', 'real');
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, 'files', `${i}.txt`), 'changed\n');
    git('commit', '-qam', 'real'); const real = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'master');
    for (const [n, sha] of [[1, modes], [2, generated], [3, real]] as const) git('update-ref', `refs/pull/${n}/head`, sha);
    expect(await cmdFleetDirtyLanded(['--json'], { gh: ghReturning([row(1, modes), row(2, generated), row(3, real)]), remote: dir })).toBe(0);
    const report = JSON.parse(output[0]!) as DirtyLandedReport;
    expect(report.prs[0]?.diffAnomaly).toEqual({ kind: 'zero-line', files: 1000, causes: ['mode-only'] });
    expect(report.prs[1]?.diffAnomaly).toEqual({ kind: 'zero-line', files: 1000, causes: ['generated-path'] });
    expect(report.prs[2]?.diffAnomaly).toBeUndefined();
    expect(recutDropJob(report.prs[0]!, Date.now())).toEqual({ reason: 'diff-anomaly' });
  }, 30000);

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
