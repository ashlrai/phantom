import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyConflictPath, planMechanicalResolution, resolveMechanically, unionResolve, type ConflictResolveIo,
} from '../src/core/fleet/conflict-resolve.js';

const sh = promisify(execFile);

describe('classifyConflictPath', () => {
  it.each([
    ['package-lock.json', 'lockfile'], ['pnpm-lock.yaml', 'lockfile'],
    ['docs/llms.txt', 'generated'], ['llms.txt', 'generated'], ['CHANGELOG.md', 'changelog'],
    ['src/core/x.ts', 'real'], ['packages/a/package-lock.json', 'real'],
    ['.github/workflows/ci.yml', 'real'], ['bin/dispatchd.py', 'real'], ['../CHANGELOG.md', 'real'],
  ])('%s is %s', (path, kind) => {
    expect(classifyConflictPath(path).kind).toBe(kind);
  });
});

describe('planMechanicalResolution', () => {
  it('is mechanical only when every path is', () => {
    expect(planMechanicalResolution(['package-lock.json', 'CHANGELOG.md']).verdict).toBe('mechanical');
    const mixed = planMechanicalResolution(['package-lock.json', 'src/a.ts']);
    expect(mixed.verdict).toBe('real');
    expect(mixed.real.map((c) => c.path)).toEqual(['src/a.ts']);
    expect(planMechanicalResolution([]).verdict).toBe('none');
  });
});

describe('unionResolve', () => {
  it('keeps both sides and drops duplicate lines', () => {
    const text = ['# Changelog', '<<<<<<< HEAD', '- a', '- shared', '=======', '- shared', '- b', '>>>>>>> master', 'tail'].join('\n');
    expect(unionResolve(text)).toEqual({ ok: true, text: ['# Changelog', '- a', '- shared', '- b', 'tail'].join('\n'), hunks: 1 });
  });
  it('handles several hunks', () => {
    const text = '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\nmid\n<<<<<<< a\n1\n=======\n2\n>>>>>>> b';
    expect(unionResolve(text)).toMatchObject({ ok: true, text: 'x\ny\nmid\n1\n2', hunks: 2 });
  });
  it.each([
    ['diff3', '<<<<<<< a\nx\n||||||| base\nz\n=======\ny\n>>>>>>> b'],
    ['unterminated', '<<<<<<< a\nx\n=======\ny'],
    ['stray', 'x\n=======\ny'],
    ['nested', '<<<<<<< a\n<<<<<<< b\n=======\n>>>>>>> c'],
  ])('fails closed on %s markers', (_n, text) => {
    expect(unionResolve(text).ok).toBe(false);
  });
});

describe('resolveMechanically (real git in a temp repo)', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

  async function setup(files: { base: Record<string, string>; master: Record<string, string>; pr: Record<string, string> }) {
    const dir = await mkdtemp(join(tmpdir(), 'conflict-resolve-'));
    dirs.push(dir);
    const git = async (args: string[], allowFail = false) => {
      try {
        const { stdout } = await sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
        return { code: 0, stdout };
      } catch (e) {
        if (!allowFail) throw e;
        return { code: 1, stdout: '' };
      }
    };
    const put = async (set: Record<string, string>) => {
      for (const [p, t] of Object.entries(set)) {
        await mkdir(dirname(join(dir, p)), { recursive: true });
        await writeFile(join(dir, p), t);
      }
      await git(['add', '-A']);
      await git(['commit', '-m', 'c']);
    };
    await git(['init', '-b', 'master']);
    await put(files.base);
    await git(['checkout', '-b', 'pr']);
    await put(files.pr);
    await git(['checkout', 'master']);
    await put(files.master);
    await git(['checkout', 'pr']);
    const generated: string[][] = [];
    const io: ConflictResolveIo = {
      git: (args, o) => git(args, o?.allowFail),
      read: (p) => readFile(join(dir, p), 'utf8'),
      write: (p, t) => writeFile(join(dir, p), t),
      run: async (argv) => {
        generated.push([...argv]);
        // Stand-in generator: rewrites the file deterministically from the merged inputs.
        await writeFile(join(dir, 'docs/llms.txt'), 'regenerated\n');
        await writeFile(join(dir, 'package-lock.json'), '{"regenerated":true}\n');
        return true;
      },
    };
    return { dir, io, generated, git };
  }

  it('merges cleanly when nothing conflicts', async () => {
    const { io } = await setup({ base: { 'a.txt': '1\n' }, master: { 'b.txt': 'm\n' }, pr: { 'c.txt': 'p\n' } });
    const r = await resolveMechanically(io, 'master');
    expect(r.status).toBe('clean-merge');
  });

  it('resolves changelog, lockfile and generated conflicts without a model', async () => {
    const { io, generated, dir, git } = await setup({
      base: { 'CHANGELOG.md': '# Log\n', 'package-lock.json': '{}\n', 'docs/llms.txt': 'v0\n' },
      master: { 'CHANGELOG.md': '# Log\n- master entry\n', 'package-lock.json': '{"m":1}\n', 'docs/llms.txt': 'master\n' },
      pr: { 'CHANGELOG.md': '# Log\n- pr entry\n', 'package-lock.json': '{"p":1}\n', 'docs/llms.txt': 'pr\n' },
    });
    const r = await resolveMechanically(io, 'master');
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && r.resolved.sort()).toEqual(['CHANGELOG.md', 'docs/llms.txt', 'package-lock.json']);
    const log = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(log).toContain('- master entry');
    expect(log).toContain('- pr entry');
    expect(log).not.toMatch(/[<>=]{7}/);
    expect(await readFile(join(dir, 'docs/llms.txt'), 'utf8')).toBe('regenerated\n');
    expect(generated).toHaveLength(2);
    // A merge commit: two parents, history untouched.
    expect((await git(['rev-list', '--parents', '-n1', 'HEAD'])).stdout.trim().split(' ')).toHaveLength(3);
  });

  it('aborts and leaves the head untouched when a real conflict is present', async () => {
    const { io, dir, git } = await setup({
      base: { 'src/a.ts': 'x\n', 'package-lock.json': '{}\n' },
      master: { 'src/a.ts': 'm\n', 'package-lock.json': '{"m":1}\n' },
      pr: { 'src/a.ts': 'p\n', 'package-lock.json': '{"p":1}\n' },
    });
    const head = (await git(['rev-parse', 'HEAD'])).stdout;
    const r = await resolveMechanically(io, 'master');
    expect(r).toMatchObject({ status: 'real', real: ['src/a.ts'], mechanical: ['package-lock.json'] });
    expect((await git(['rev-parse', 'HEAD'])).stdout).toBe(head);
    expect((await git(['status', '--porcelain'])).stdout.trim()).toBe('');
    expect(await readFile(join(dir, 'src/a.ts'), 'utf8')).toBe('p\n');
  });

  it('treats a failing generator as a real conflict and aborts', async () => {
    const { io, git } = await setup({
      base: { 'package-lock.json': '{}\n' }, master: { 'package-lock.json': '{"m":1}\n' }, pr: { 'package-lock.json': '{"p":1}\n' },
    });
    const head = (await git(['rev-parse', 'HEAD'])).stdout;
    const r = await resolveMechanically({ ...io, run: async () => false }, 'master');
    expect(r.status).toBe('real');
    expect((await git(['rev-parse', 'HEAD'])).stdout).toBe(head);
  });

  it('never treats a workflow file as mechanical', async () => {
    const { io } = await setup({
      base: { '.github/workflows/ci.yml': 'a\n' }, master: { '.github/workflows/ci.yml': 'm\n' }, pr: { '.github/workflows/ci.yml': 'p\n' },
    });
    expect((await resolveMechanically(io, 'master')).status).toBe('real');
  });

  it('rejects option-shaped base refs', async () => {
    const { io } = await setup({ base: { 'a': '1\n' }, master: { 'b': '1\n' }, pr: { 'c': '1\n' } });
    expect(await resolveMechanically(io, '--upload-pack=x')).toEqual({ status: 'failed', reason: 'bad-base-ref' });
  });
});
