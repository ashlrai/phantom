/**
 * RELEASE-CONTINUOUS-1 (2): a stale generated file is regenerated inside the
 * release job and can never block a release. v3.30.34 tagged a commit that
 * added docs/release-notes/3.30.34.md without refreshing docs/llms.txt; its
 * master push CI went red at "Check generated files" and the release build
 * never ran. The Release PR now regenerates every tracked generated file with
 * the same list CI checks, so the release commit is fresh by construction.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error untyped repository script
import { GENERATED_FILES, regenerateTrackedFiles } from '../scripts/regenerate-tracked-files.mjs';

const ROOT = join(__dirname, '..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A minimal docs tree: the real llms-source.txt plus one page, with llms.txt generated fresh. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'release-regenerate-'));
  dirs.push(root);
  mkdirSync(join(root, 'docs', 'release-notes'), { recursive: true });
  copyFileSync(join(ROOT, 'docs', 'llms-source.txt'), join(root, 'docs', 'llms-source.txt'));
  writeFileSync(join(root, 'docs', 'GUIDE.md'), '# Guide\n\nHow to use the workbench.\n');
  writeFileSync(join(root, 'docs', 'llms.txt'), '');
  expect(regenerateTrackedFiles(root)).toEqual(['docs/llms.txt']);
  return root;
}

type Step = { name?: string; run?: string; if?: string };
function steps(file: string, job: string): Step[] {
  const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
  return workflow.jobs[job]!.steps;
}

describe('generated files regenerate inside the release job', () => {
  it('a fresh tree reports no change and writes nothing', () => {
    const root = fixture();
    const before = readFileSync(join(root, 'docs', 'llms.txt'), 'utf8');
    expect(regenerateTrackedFiles(root)).toEqual([]);
    expect(readFileSync(join(root, 'docs', 'llms.txt'), 'utf8')).toBe(before);
  });

  it('a release-notes page added without regenerating (the v3.30.34 shape) is rewritten, then fresh', () => {
    const root = fixture();
    writeFileSync(join(root, 'docs', 'release-notes', '9.9.9.md'), '# Phantom 9.9.9 release notes\n\nWhat shipped since 9.9.8.\n');
    const stale = readFileSync(join(root, 'docs', 'llms.txt'), 'utf8');
    expect(stale).not.toContain('release-notes/9.9.9.md');

    expect(regenerateTrackedFiles(root, { write: false })).toEqual(['docs/llms.txt']);
    expect(readFileSync(join(root, 'docs', 'llms.txt'), 'utf8'), '--check mode never writes').toBe(stale);

    expect(regenerateTrackedFiles(root)).toEqual(['docs/llms.txt']);
    expect(readFileSync(join(root, 'docs', 'llms.txt'), 'utf8')).toContain('release-notes/9.9.9.md');
    expect(regenerateTrackedFiles(root, { write: false })).toEqual([]);
  });

  it('the checked-in tree is fresh', () => {
    expect(regenerateTrackedFiles(ROOT, { write: false })).toEqual([]);
  });

  it('lists docs/llms.txt and keeps every path repo-relative', () => {
    const paths = GENERATED_FILES.map((entry: { path: string }) => entry.path);
    expect(paths).toContain('docs/llms.txt');
    for (const path of paths) expect(path).toMatch(/^[a-z0-9][a-z0-9._/-]*$/i);
  });

  it('the Release PR regenerates before it commits, with the same list CI checks', () => {
    const sync = steps('release-please.yml', 'sync-and-refresh').find((step) => step.name === 'Sync candidate version carriers, or refresh, in one commit');
    expect(sync?.run).toBeDefined();
    const run = sync!.run!;
    expect(run).toContain('node scripts/regenerate-tracked-files.mjs');
    expect(run.indexOf('node scripts/regenerate-tracked-files.mjs')).toBeLessThan(run.indexOf('git add -A'));
    expect(run).not.toContain('regenerate-tracked-files.mjs --check');

    const check = steps('ci.yml', 'clean-tree').find((step) => step.name === 'Check generated files');
    expect(check?.run).toContain('node scripts/regenerate-tracked-files.mjs');
    expect(check?.run).toContain('git status --porcelain --untracked-files=normal');
  });
});
