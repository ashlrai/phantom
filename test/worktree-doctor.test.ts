import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDoctorWorktree } from '../src/cli/doctor-worktree.js';
import { inspectWorktree, readRepairLog, realProbe, renderWorktreeReport, repairWorktree, WORKTREE_DOCTOR_SCHEMA, type RepairRunner, type WorktreeProbe } from '../src/core/worktree-doctor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(parts: { tsgo?: boolean; eslintPackage?: boolean; eslintLib?: boolean; modules?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-doctor-'));
  dirs.push(root);
  if (parts.modules === false) return root;
  const modules = join(root, 'node_modules');
  mkdirSync(join(modules, '.bin'), { recursive: true });
  if (parts.tsgo) writeFileSync(join(modules, '.bin', 'tsgo'), 'x');
  if (parts.eslintPackage) {
    mkdirSync(join(modules, 'eslint', 'bin'), { recursive: true });
    writeFileSync(join(modules, 'eslint', 'package.json'), '{}');
  }
  if (parts.eslintLib) {
    mkdirSync(join(modules, 'eslint', 'lib'), { recursive: true });
    writeFileSync(join(modules, 'eslint', 'lib', 'cli.js'), 'x');
  }
  return root;
}
const starts = (ok: boolean): WorktreeProbe => ({ ...realProbe, starts: () => ok });
const FIX = 'npm ci --ignore-scripts --no-audit --no-fund';

describe('inspectWorktree', () => {
  it('reports all good with no next step', () => {
    const report = inspectWorktree(fixture({ tsgo: true, eslintPackage: true, eslintLib: true }), starts(true));
    expect(report).toMatchObject({ schema: WORKTREE_DOCTOR_SCHEMA, ok: true, nextStep: null });
    expect(report.tsgo.state).toBe('ok');
    expect(report.eslint.state).toBe('ok');
    expect(renderWorktreeReport(report)).toContain('can typecheck and lint');
  });

  it('names the fix when tsgo is missing', () => {
    const report = inspectWorktree(fixture({ eslintPackage: true, eslintLib: true }), starts(true));
    expect(report.ok).toBe(false);
    expect(report.tsgo).toMatchObject({ state: 'missing', fix: FIX });
    expect(report.eslint.state).toBe('ok');
    expect(report.nextStep).toBe(FIX);
  });

  it('names the fix when the eslint lib folder is missing', () => {
    const report = inspectWorktree(fixture({ tsgo: true, eslintPackage: true }), starts(true));
    expect(report.eslint.state).toBe('broken');
    expect(report.eslint.detail).toContain('eslint/lib/cli');
    expect(report.eslint.fix).toBe(FIX);
    expect(report.tsgo.state).toBe('ok');
  });

  it('flags tools that are present but do not start', () => {
    const report = inspectWorktree(fixture({ tsgo: true, eslintPackage: true, eslintLib: true }), starts(false));
    expect(report.tsgo.state).toBe('broken');
    expect(report.eslint.state).toBe('broken');
  });

  it('reports a missing node_modules and blocks the tool checks', () => {
    const report = inspectWorktree(fixture({ modules: false }), starts(true));
    expect(report.nodeModules).toMatchObject({ state: 'missing', fix: FIX });
    expect(report.tsgo.state).toBe('missing');
    expect(report.eslint.state).toBe('missing');
    expect(report.nextStep).toBe(FIX);
  });

  it('handles a dangling node_modules link and says to remove the link first', () => {
    const root = fixture({ modules: false });
    symlinkSync(join(root, 'gone'), join(root, 'node_modules'));
    // existsSync follows the link, so a dangling one reads as absent: still one clear fix.
    const report = inspectWorktree(root, starts(true));
    expect(report.nodeModules.state).not.toBe('ok');
    expect(report.nextStep).toContain('npm ci');
  });

  it('marks a linked node_modules as shared', () => {
    const real = fixture({ tsgo: true, eslintPackage: true, eslintLib: true });
    const root = fixture({ modules: false });
    symlinkSync(join(real, 'node_modules'), join(root, 'node_modules'));
    const report = inspectWorktree(root, starts(true));
    expect(report.nodeModules).toMatchObject({ state: 'ok', shared: true });
  });
});

describe('phm doctor worktree', () => {
  it('prints typed JSON and exits 1 when something is wrong', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDoctorWorktree(['--json'], fixture({ modules: false }))).toBe(1);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ schema: 'phm.doctor.worktree/1', ok: false, nextStep: FIX });
  });

  it('rejects unknown options without acting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdDoctorWorktree(['--fix'], fixture({ modules: false }))).toBe(2);
  });
});

/** A fake `git` keyed by the first args; null means git failed. */
function gitProbe(answers: Record<string, string | null>, files: Record<string, string> = {}, ok = true): WorktreeProbe {
  return {
    ...realProbe,
    starts: () => ok,
    git: (args) => answers[args.join(' ')] ?? null,
    readText: (path) => files[path] ?? null,
  };
}
const SOURCE = '/fixture/source';
const gitAnswers = (behind: string | null) => ({
  'rev-parse --git-common-dir': `${SOURCE}/.git`,
  'rev-parse --abbrev-ref HEAD': 'side-branch',
  'rev-list --count HEAD..origin/master': behind,
  'show origin/master:package-lock.json': '{"v":2}',
});

describe('source checkout report', () => {
  it('reports a source that is behind master with a lockfile mismatch as the cause', () => {
    const probe = gitProbe(gitAnswers('412'), { [`${SOURCE}/package-lock.json`]: '{"v":1}' });
    const report = inspectWorktree(fixture({}), probe);
    expect(report.source).toMatchObject({ path: SOURCE, branch: 'side-branch', behind: 412, lock: 'mismatch' });
    expect(report.ok).toBe(false);
    expect(report.cause).toContain('stale checkout');
    expect(renderWorktreeReport(report)).toContain('412 commits behind origin/master');
    expect(renderWorktreeReport(report)).toContain('DIFFERS');
  });

  it('reports a current source with a matching lockfile and no stale cause', () => {
    const probe = gitProbe(gitAnswers('0'), { [`${SOURCE}/package-lock.json`]: '{"v":2}\n' });
    const report = inspectWorktree(fixture({ tsgo: true, eslintPackage: true, eslintLib: true }), probe);
    expect(report.source).toMatchObject({ behind: 0, lock: 'match' });
    expect(report.cause).toBeNull();
    expect(renderWorktreeReport(report)).toContain('up to date with origin/master');
  });

  it('shows unknown as unknown when git cannot answer', () => {
    const report = inspectWorktree(fixture({}), gitProbe({}));
    expect(report.source).toEqual({ path: null, branch: null, behind: null, lock: 'unknown', repairLog: [] });
    expect(renderWorktreeReport(report)).toContain('source checkout: unknown');
    const half = inspectWorktree(fixture({}), gitProbe(gitAnswers(null)));
    expect(half.source).toMatchObject({ behind: null, lock: 'unknown' });
  });

  it('reads an empty and a present repair log, last 5 lines only', () => {
    const log = `${SOURCE}/.git/bridge-source-repair.jsonl`;
    expect(readRepairLog(SOURCE, gitProbe({}))).toEqual([]);
    const rows = Array.from({ length: 7 }, (_, i) => JSON.stringify({ at: `t${i}`, event: i === 6 ? 'repaired' : 'skipped', reason: `r${i}` }));
    const probe = gitProbe({}, { [log]: `${rows.join('\n')}\nnot json\n` });
    // .git does not exist on disk, so the log path falls back to the source root.
    const fallback = `${SOURCE}/bridge-source-repair.jsonl`;
    const entries = readRepairLog(SOURCE, { ...probe, readText: (p) => (p === fallback ? `${rows.join('\n')}\nnot json\n` : null) });
    expect(entries).toHaveLength(5);
    expect(entries[4]).toEqual({ at: 't6', event: 'repaired', reason: 'r6' });
    expect(entries[0]?.at).toBe('t2');
  });
});

describe('phm doctor worktree --repair', () => {
  const mockRunner = (code: number | null, onRun?: () => void): RepairRunner & { calls: Array<[string, string[], string]> } => {
    const calls: Array<[string, string[], string]> = [];
    return { calls, run: (c, a, cwd) => { calls.push([c, a, cwd]); onRun?.(); return code; } };
  };

  it('runs npm ci in this worktree only and re-probes (mocked runner)', () => {
    const root = fixture({ modules: false });
    const runner = mockRunner(0, () => {
      mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(root, 'node_modules', '.bin', 'tsgo'), 'x');
      mkdirSync(join(root, 'node_modules', 'eslint', 'lib'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'eslint', 'package.json'), '{}');
      writeFileSync(join(root, 'node_modules', 'eslint', 'lib', 'cli.js'), 'x');
    });
    mkdirSync(join(root, 'gitdir'));
    const report = repairWorktree(root, gitProbe({ ...gitAnswers('3'), 'rev-parse --absolute-git-dir': join(root, 'gitdir') }), runner);
    expect(runner.calls).toEqual([['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root]]);
    expect(report.repair).toMatchObject({ ran: true, ok: true });
    expect(report.ok).toBe(true);
    expect(existsSync(join(root, 'gitdir', 'bridge-worktree-repair.lock'))).toBe(false);
  });

  it('reports a failed install without claiming success', () => {
    const runner = mockRunner(1);
    const report = repairWorktree(fixture({ modules: false }), gitProbe({}), runner);
    expect(report.repair).toMatchObject({ ran: true, ok: false });
    expect(report.repair?.detail).toContain('exit 1');
    expect(report.ok).toBe(false);
  });

  it('refuses to run in the source checkout', () => {
    const root = fixture({ modules: false });
    const runner = mockRunner(0);
    const report = repairWorktree(root, gitProbe({ 'rev-parse --git-common-dir': join(root, '.git') }), runner);
    expect(runner.calls).toEqual([]);
    expect(report.repair).toMatchObject({ ran: false, ok: false });
  });

  it('does not start a second repair while the lock is held', () => {
    const root = fixture({ modules: false });
    mkdirSync(join(root, 'bridge-worktree-repair.lock'));
    const runner = mockRunner(0);
    const report = repairWorktree(root, gitProbe({}), runner);
    expect(runner.calls).toEqual([]);
    expect(report.repair?.detail).toContain('already running');
  });

  it('prints --json with the schema id and the source section', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdDoctorWorktree(['--json'], fixture({ modules: false }));
    const json = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(json.schema).toBe('phm.doctor.worktree/1');
    expect(json.source).toMatchObject({ repairLog: expect.any(Array), lock: expect.any(String) });
  });
});

describe('source checkout against real git', () => {
  it('finds the source of a linked worktree', () => {
    const base = mkdtempSync(join(tmpdir(), 'wt-src-'));
    dirs.push(base);
    const git = (...a: string[]) => execFileSync('git', ['-C', join(base, 'src'), ...a], { stdio: 'ignore' });
    mkdirSync(join(base, 'src'));
    git('init', '-q', '-b', 'master');
    writeFileSync(join(base, 'src', 'package-lock.json'), '{}');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one');
    git('worktree', 'add', '-q', join(base, 'job'));
    const report = inspectWorktree(join(base, 'job'), starts(true));
    expect(report.source.path).toBe(realpathOf(join(base, 'src')));
    // No origin remote: behind and lock stay unknown rather than guessed.
    expect(report.source).toMatchObject({ branch: 'master', behind: null, lock: 'unknown' });
  });
});
const realpathOf = (p: string) => execFileSync('node', ['-e', 'console.log(require("fs").realpathSync(process.argv[1]))', p]).toString().trim();
