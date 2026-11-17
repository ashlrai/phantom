import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvePrConflicts, type ConflictPr } from '../src/core/fleet/pr-conflict-resolver.js';
import { cmdPr } from '../src/cli/pr.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(path = 'CONTRACT.md', base = 'anchor\n', ours = 'anchor\nours\n', theirs = 'anchor\ntheirs\n', baseFiles: Record<string, string> = {}, prFiles: Record<string, string> = {}) {
  vi.stubEnv('GIT_AUTHOR_NAME', 'Fixture'); vi.stubEnv('GIT_AUTHOR_EMAIL', 'fixture@example.test');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Fixture'); vi.stubEnv('GIT_COMMITTER_EMAIL', 'fixture@example.test');
  const root = await mkdtemp(join(tmpdir(), 'conflict-fixture-')); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  git(repo, 'init', '-b', 'master');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.test');
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), base);
  for (const [name, text] of Object.entries(baseFiles)) {
    await mkdir(dirname(join(repo, name)), { recursive: true }); await writeFile(join(repo, name), text);
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'checkout', '-b', 'codex-bridge/fixture');
  await writeFile(join(repo, path), ours);
  for (const [name, text] of Object.entries(prFiles)) {
    await mkdir(dirname(join(repo, name)), { recursive: true }); await writeFile(join(repo, name), text);
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'ours');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/pull/42/head', headSha);
  git(repo, 'checkout', 'master');
  await writeFile(join(repo, path), theirs); git(repo, 'commit', '-am', 'theirs');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  const pr: ConflictPr = { number: 42, state: 'OPEN', headSha, headRef: 'codex-bridge/fixture',
    headRepo: 'masonwyatt23/phantom', baseRef: 'master' };
  const run = vi.fn(async (_cwd: string, _argv: readonly string[]) => true);
  const options = { repo: 'ashlrai/phantom', remote: repo, defaultBranch: 'master', pr, hold: new Set<string>(),
    outputDir: join(root, 'out'), run, refresh: async () => pr };
  return { root, repo, path, headSha, baseSha, pr, run, options };
}

describe('PR conflict resolver with real isolated git merges', () => {
  it('unions pure append conflicts, PR first, and verifies before producing a supersede bundle', async () => {
    const f = await fixture('CONTRACT.md', 'anchor\n', 'anchor\nours\n', 'anchor\ntheirs\n', {}, { 'feature.md': 'the full PR delta\n' });
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.status, JSON.stringify(result)).toBe('ready-supersede');
    expect(result.files).toEqual(['CONTRACT.md']);
    expect(f.run.mock.calls.map(call => call[1])).toEqual([['node', 'scripts/verify-changed.mjs']]);
    expect(result.bundle).toBeTruthy();
    const dest = join(f.root, 'consumer'); git(f.root, 'clone', f.repo, dest);
    git(dest, 'fetch', result.bundle!, 'HEAD');
    expect(git(dest, 'show', 'FETCH_HEAD:CONTRACT.md')).toBe('anchor\nours\ntheirs');
    expect(git(dest, 'show', 'FETCH_HEAD:feature.md')).toBe('the full PR delta');
    expect(git(dest, 'rev-list', '--parents', '-1', 'FETCH_HEAD').split(' ').slice(1)).toEqual([f.baseSha]);
    expect(git(dest, 'rev-list', '--count', `${f.baseSha}..FETCH_HEAD`)).toBe('1');
    expect(git(f.repo, 'rev-parse', 'master')).toBe(f.baseSha);
    expect(git(f.repo, 'rev-parse', f.pr.headRef)).toBe(f.headSha);
  });

  it('dedupes identical added lines inside a contested insertion', async () => {
    const f = await fixture('CONTRACT.md', 'a\n', 'a\ncommon\nours\n', 'a\ncommon\ntheirs\n');
    f.options.run = vi.fn(async (cwd: string) => {
      expect(await readFile(join(cwd, f.path), 'utf8')).toBe('a\ncommon\nours\ntheirs\n'); return true;
    });
    expect((await resolvePrConflicts({ ...f.options, apply: true })).status).toBe('ready-supersede');
  });

  it('refuses a modified shared line with file and hunk evidence', async () => {
    const f = await fixture('CONTRACT.md', 'old\n', 'ours\n', 'theirs\n');
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.status).toBe('needs-agent'); expect(result.reason).toContain('insertion');
    expect(result.hunks[0]).toMatchObject({ path: 'CONTRACT.md', base: 'old\n' });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('refuses a GATES path even if explicitly configured as append-union', async () => {
    const f = await fixture('contrib/mac/publish.sh');
    const result = await resolvePrConflicts({ ...f.options, apply: true, allowlist: [f.path] });
    expect(result.status).toBe('needs-agent'); expect(result.reason).toContain('GATES');
    expect(result.files).toEqual([f.path]); expect(f.run).not.toHaveBeenCalled();
  });

  it('skips a hold-list PR without verification or publication', async () => {
    const f = await fixture();
    const result = await resolvePrConflicts({ ...f.options, apply: true, hold: new Set(['phantom#42']) });
    expect(result).toMatchObject({ status: 'needs-agent', reason: 'hold-list' }); expect(f.run).not.toHaveBeenCalled();
  });

  it('reruns the real fixture docs generator before verification and bundles its output', async () => {
    const f = await fixture('docs/llms.txt', 'a\n', 'a\nours\n', 'a\ntheirs\n', {
      'scripts/generate-docs-llms.mjs': "import {writeFileSync} from 'node:fs'; writeFileSync('docs/llms.txt', 'regenerated\\n');",
      'scripts/verify-changed.mjs': "import {readFileSync} from 'node:fs'; if(readFileSync('docs/llms.txt', 'utf8') !== 'regenerated\\n') process.exit(1);",
    });
    f.options.run = vi.fn(async (cwd, argv) => {
      execFileSync(argv[0]!, argv.slice(1), { cwd, stdio: 'pipe' }); return true;
    });
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.status, JSON.stringify(result)).toBe('ready-supersede');
    expect(f.options.run.mock.calls.map(call => call[1])).toEqual([
      ['node', 'scripts/generate-docs-llms.mjs'], ['node', 'scripts/verify-changed.mjs'],
    ]);
    git(f.repo, 'fetch', result.bundle!, 'HEAD');
    expect(git(f.repo, 'show', 'FETCH_HEAD:docs/llms.txt')).toBe('regenerated');
  });

  it('defaults to dry-run, without running scripts, publishing or creating an output directory', async () => {
    const f = await fixture();
    const result = await resolvePrConflicts(f.options);
    expect(result).toMatchObject({ status: 'would-resolve', dryRun: true }); expect(f.run).not.toHaveBeenCalled();
    expect(result.bundle).toBeUndefined();
    expect(await stat(f.options.outputDir).catch(() => null)).toBeNull();
    expect(git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('conflictres-');
  });

  it('reruns authority regeneration for a registry conflict, despite its Tier-1 path', async () => {
    const f = await fixture('src/cli/completions.ts');
    expect((await resolvePrConflicts({ ...f.options, apply: true })).status).toBe('ready-supersede');
    expect(f.run.mock.calls.map(call => call[1])).toEqual([
      ['npm', 'run', 'authority:regen'], ['node', 'scripts/verify-changed.mjs'],
    ]);
  });

  it('refuses code outside the allowlist, without publishing any safe subset', async () => {
    const f = await fixture('src/implementation.ts');
    const publish = vi.fn();
    const result = await resolvePrConflicts({ ...f.options, apply: true, publish });
    expect(result).toMatchObject({ status: 'needs-agent', files: [f.path] });
    expect(result.hunks).toHaveLength(1); expect(f.run).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a deletion conflict', async () => {
    const f = await fixture('CONTRACT.md', 'a\nold\nz\n', 'a\nz\n', 'a\nchanged\nz\n');
    expect((await resolvePrConflicts({ ...f.options, apply: true })).status).toBe('needs-agent'); expect(f.run).not.toHaveBeenCalled();
  });

  it('refuses the whole PR when only one of two hunks modifies a shared line', async () => {
    const gap = 'gap1\ngap2\ngap3\ngap4\ngap5\ngap6\ngap7\n';
    const f = await fixture('CONTRACT.md', `a\n${gap}old\n`, `a\nours\n${gap}edited\n`, `a\ntheirs\n${gap}changed\n`);
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.status).toBe('needs-agent'); expect(result.hunks).toHaveLength(2); expect(f.run).not.toHaveBeenCalled();
  });

  it.each([['node', 'scripts/verify-changed.mjs'], ['node', 'scripts/generate-docs-llms.mjs']])('fails closed when command %j %j fails', async (bin, script) => {
    const f = await fixture('docs/llms.txt');
    f.options.run = vi.fn(async (_cwd, argv) => argv.join(' ') !== `${bin} ${script}`);
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.status).toBe('needs-agent'); expect(result.reason).toContain('command failed'); expect(result.bundle).toBeUndefined();
  });

  it('rechecks the head and master after verification', async () => {
    const f = await fixture();
    const moved = await resolvePrConflicts({ ...f.options, apply: true, refresh: async () => ({ ...f.pr, headSha: 'f'.repeat(40) }) });
    expect(moved.reason).toContain('identity');
    f.options.run = vi.fn(async () => { await writeFile(join(f.repo, 'new.txt'), 'master moved'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'move master'); return true; });
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.reason).toBe('master moved; rerun'); expect(result.bundle).toBeUndefined();
  });

  it('never targets a default branch or publishes without an approved fork adapter', async () => {
    const f = await fixture(); const publish = vi.fn(async () => true);
    const blocked = await resolvePrConflicts({ ...f.options, apply: true, pr: { ...f.pr, headRef: 'master' }, publish,
      allowedHeadRepos: new Set([f.pr.headRepo]) });
    expect(blocked.status).toBe('needs-agent'); expect(publish).not.toHaveBeenCalled();
    const unsupported = await resolvePrConflicts({ ...f.options, apply: true, publish });
    expect(unsupported.status).toBe('ready-supersede'); expect(publish).not.toHaveBeenCalled();
    const supported = await resolvePrConflicts({ ...f.options, apply: true, publish, allowedHeadRepos: new Set([f.pr.headRepo]) });
    expect(supported.status).toBe('published'); expect(publish).toHaveBeenCalledWith(expect.objectContaining({ pr: f.pr, base: f.baseSha, commit: supported.commit }));
  });

  it('cannot override constitution holds with an empty configured list', async () => {
    const f = await fixture();
    expect(await resolvePrConflicts({ ...f.options, apply: true, pr: { ...f.pr, number: 197 } })).toMatchObject({ status: 'needs-agent', reason: 'hold-list' });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('refuses an undeclared generator output even when the generator stages it', async () => {
    const f = await fixture('docs/llms.txt');
    f.options.run = vi.fn(async (cwd) => {
      await writeFile(join(cwd, 'unexpected.md'), 'not an output'); git(cwd, 'add', 'unexpected.md'); return true;
    });
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.reason).toBe('generator changed undeclared files'); expect(result.bundle).toBeUndefined();
  });

  it.each(['unstaged', 'staged', 'committed'])('refuses %s writes by verification', async (kind) => {
    const f = await fixture();
    f.options.run = vi.fn(async (cwd) => {
      await writeFile(join(cwd, f.path), 'verification changed the tree\n');
      if (kind !== 'unstaged') git(cwd, 'add', f.path);
      if (kind === 'committed') git(cwd, 'commit', '-m', 'verification write');
      return true;
    });
    const result = await resolvePrConflicts({ ...f.options, apply: true });
    expect(result.reason).toBe('verification changed the committed tree'); expect(result.bundle).toBeUndefined();
  });

  it('CLI defaults to dry-run and requires an explicit apply flag', async () => {
    const resolveOne = vi.fn(async () => ({ status: 'would-resolve' }));
    const stdout = vi.fn();
    expect(await cmdPr(['resolve-conflicts', '--json'], { run: resolveOne, stdout })).toBe(0);
    expect(resolveOne).toHaveBeenCalledWith(expect.objectContaining({ apply: false }));
  });
});
