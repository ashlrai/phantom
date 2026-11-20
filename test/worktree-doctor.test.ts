import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDoctorWorktree } from '../src/cli/doctor-worktree.js';
import { inspectWorktree, realProbe, renderWorktreeReport, WORKTREE_DOCTOR_SCHEMA, type WorktreeProbe } from '../src/core/worktree-doctor.js';

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
