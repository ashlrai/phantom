import * as childProcess from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPlannerSlate } from '../src/cli/fleet-planner-slate.js';
import { PLANNER_CANDIDATES_FILE, readPlannerCandidates } from '../src/core/fleet/planner-candidates.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('unexpected subprocess'); }),
  spawnSync: vi.fn(() => { throw new Error('unexpected subprocess'); }),
  execFile: vi.fn(() => { throw new Error('unexpected subprocess'); }),
  execFileSync: vi.fn(() => { throw new Error('unexpected subprocess'); }),
}));

const roots: string[] = [];
function fixture(): { base: string; root: string; path: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slate-write-'))); roots.push(base);
  const root = join(base, 'new-runs');
  return { base, root, path: join(root, PLANNER_CANDIDATES_FILE) };
}
const slate = { v: 1, candidates: [
  { provider: 'first', argv: ['fake-exe', '  spaces ', '$(never-run)', '', 'é'] },
  { provider: 'second', argv: ['other', 'line\nbreak'] },
], lastProvider: 'second' };
async function run(root: string, input: string | Buffer, args: string[] = []): Promise<{ code: number; output: string }> {
  let output = '';
  const code = await cmdFleetPlannerSlate(['--file', '-', '--runs-dir', root, ...args], {
    stdin: (async function* () { yield Buffer.from(input); })(), stdout: { write(text) { output += text; } },
  });
  return { code, output };
}
const summary = (status: string, candidateCount: number): string => JSON.stringify({ v: 1, status, candidateCount }) + '\n';
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('fleet planner slate writer', () => {
  it('round-trips ordered data, no-ops identical slates, and atomically replaces without launching processes', async () => {
    const spies = [childProcess.spawn, childProcess.spawnSync, childProcess.execFile, childProcess.execFileSync];
    const { root, path } = fixture();
    expect(await run(root, JSON.stringify(slate), ['--json'])).toEqual({ code: 0, output: summary('written', 2) });
    expect(await readPlannerCandidates(root)).toEqual({ source: 'ok', path, candidates: slate.candidates, lastProvider: 'second' });
    if (process.platform !== 'win32') {
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(root, 'queue')).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    const bytes = readFileSync(path), oldInode = lstatSync(path).ino;
    expect(await run(root, JSON.stringify(slate))).toEqual({ code: 0, output: summary('unchanged', 2) });
    expect(readFileSync(path)).toEqual(bytes);
    expect(lstatSync(path).ino).toBe(oldInode);
    const replacement = { v: 1, candidates: [{ provider: 'new', argv: ['exe', 'arg'] }] };
    expect(await run(root, JSON.stringify(replacement))).toEqual({ code: 0, output: summary('written', 1) });
    expect(lstatSync(path).ino).not.toBe(oldInode);
    expect(await readPlannerCandidates(root)).toEqual({ source: 'ok', path, candidates: replacement.candidates, lastProvider: null });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('rejects invalid inputs before mutation, with no input or argv in output', async () => {
    const { base, root, path } = fixture();
    const missingRoot = join(base, 'untouched');
    expect((await run(missingRoot, '{')).code).toBe(2);
    expect(() => lstatSync(missingRoot)).toThrow();
    await run(root, JSON.stringify(slate));
    const bytes = readFileSync(path);
    const bad = [
      '{', Buffer.from([0xff]), Buffer.alloc(65537, 32),
      JSON.stringify({ ...slate, candidates: [] }),
      JSON.stringify({ ...slate, candidates: Array(65).fill(slate.candidates[0]) }),
      JSON.stringify({ ...slate, candidates: [slate.candidates[0], slate.candidates[0]] }),
      JSON.stringify({ ...slate, candidates: [{ provider: ' ', argv: ['a'] }] }),
      JSON.stringify({ ...slate, candidates: [{ provider: 'x'.repeat(129), argv: ['a'] }] }),
      JSON.stringify({ ...slate, candidates: [{ provider: 'x', argv: Array(65).fill('a') }] }),
      JSON.stringify({ ...slate, candidates: [{ provider: 'x', argv: ['a'.repeat(1025)] }] }),
      JSON.stringify({ ...slate, candidates: [{ provider: 'x', argv: [] }] }),
      JSON.stringify({ ...slate, candidates: [{ provider: 'x', argv: ['  '] }] }),
      JSON.stringify({ ...slate, candidates: [{ provider: 'x', argv: ['a\0b'] }] }),
      JSON.stringify({ ...slate, candidates: [{ provider: 'x', argv: ['a'], env: {} }] }),
      JSON.stringify({ ...slate, lastProvider: 'missing' }),
      JSON.stringify({ ...slate, token: 'private' }),
    ];
    for (const input of bad) {
      expect(await run(root, input)).toEqual({ code: 2, output: summary('refused', 0) });
      expect(readFileSync(path)).toEqual(bytes);
    }
    expect((await run(root, JSON.stringify(slate), ['--unexpected'])).code).toBe(2);
    expect((await run(root, JSON.stringify(slate), ['--file', '-'])).code).toBe(2);
    expect((await run('relative', JSON.stringify(slate))).code).toBe(2);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('refuses malformed existing state, symlinks, nonfiles and lock conflicts', async () => {
    const { base, root, path } = fixture();
    await run(root, JSON.stringify(slate));
    writeFileSync(path, '{broken');
    expect(await run(root, JSON.stringify(slate))).toEqual({ code: 1, output: summary('refused', 2) });
    expect(readFileSync(path, 'utf8')).toBe('{broken');
    rmSync(path);
    mkdirSync(path);
    expect((await run(root, JSON.stringify(slate))).code).toBe(1);
    rmSync(path, { recursive: true });
    const referent = join(base, 'referent'); writeFileSync(referent, 'untouched', { mode: 0o600 });
    symlinkSync(referent, path);
    expect((await run(root, JSON.stringify(slate))).code).toBe(1);
    expect(readFileSync(referent, 'utf8')).toBe('untouched');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    rmSync(path);
    const lock = join(root, 'queue', '.planner-candidates.lock'); writeFileSync(lock, 'held');
    expect((await run(root, JSON.stringify(slate))).code).toBe(1);
    expect(readFileSync(lock, 'utf8')).toBe('held');
    rmSync(lock);
    if (process.platform !== 'win32') {
      writeFileSync(path, JSON.stringify(slate)); chmodSync(path, 0o000);
      expect((await run(root, JSON.stringify(slate))).code).toBe(1);
    }
  });

  it('reads input files without exposing their contents and rejects malformed bytes', async () => {
    const { base, root, path } = fixture();
    const input = join(base, 'input.json'); writeFileSync(input, JSON.stringify(slate));
    let output = '';
    const code = await cmdFleetPlannerSlate(['--file', input, '--runs-dir', root], { stdout: { write(text) { output += text; } } });
    expect({ code, output }).toEqual({ code: 0, output: summary('written', 2) });
    expect((await readPlannerCandidates(root)).candidates).toEqual(slate.candidates);
    const bytes = readFileSync(path); writeFileSync(input, Buffer.from([0xc3, 0x28]));
    expect(await cmdFleetPlannerSlate(['--file', input, '--runs-dir', root], { stdout: { write() {} } })).toBe(2);
    expect(readFileSync(path)).toEqual(bytes);
  });
});
