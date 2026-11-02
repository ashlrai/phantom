import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextRun } from '../src/cli/fleet-context-run.js';
import { CONTEXT_START, CONTEXT_END, runContextWorker } from '../src/core/fleet/context-worker-run.js';

let root: string, snapshot: string, prompt: string, _out: string, err: string;
const CITED = 'cited upstream task marker zq9';
const PROMPT = 'base prompt for cwd test\n';
const input = () => ({ node: { jobId: 'CURRENT', upstreamJobIds: ['UPSTREAM'] },
  tasks: [{ jobId: 'UPSTREAM', text: CITED }], outputs: [], byteBudget: 2048 });
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { _out += s; }), stderr: sink(s => { err += s; }) });
const args = (flags: string[] = [], childArgs: string[] = []) =>
  ['--snapshot', snapshot, '--prompt', prompt, ...flags, '--', process.execPath, '-e', ...childArgs];
const run = (a: string[]) => cmdFleetContextRun(a, io());
// Real child records its working directory and everything it received on stdin.
const recorder = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
  `const f=require('node:fs');f.writeFileSync(process.argv[1],process.cwd());f.writeFileSync(process.argv[2],s)});`;
const marker = () => join(root, 'spawned');
const noChild = async () => expect(readFile(marker())).rejects.toMatchObject({ code: 'ENOENT' });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-cwd-solp1-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs')); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); _out = ''; err = '';
  await writeFile(snapshot, JSON.stringify(input())); await writeFile(prompt, PROMPT);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('launches the worker in the selected directory with the cited pack on stdin', async () => {
  const selected = join(root, 'selected checkout $(phony);[x]');
  await mkdir(selected);
  const cwdFile = join(root, 'child-cwd'), stdinFile = join(root, 'child-stdin');
  const before = process.cwd();
  expect(await run(args(['--cwd', selected], [recorder, '--', cwdFile, stdinFile]))).toBe(0);
  expect(await readFile(cwdFile, 'utf8')).toBe(realpathSync(selected));
  const stdin = await readFile(stdinFile, 'utf8');
  expect(stdin.startsWith(PROMPT + CONTEXT_START)).toBe(true);
  expect(stdin.endsWith(CONTEXT_END)).toBe(true);
  expect(stdin).toContain(CITED);
  expect(process.cwd()).toBe(before);
}, 30000);

it('keeps the runner working directory when --cwd is omitted', async () => {
  const cwdFile = join(root, 'child-cwd'), stdinFile = join(root, 'child-stdin');
  expect(await run(args([], [recorder, '--', cwdFile, stdinFile]))).toBe(0);
  expect(await readFile(cwdFile, 'utf8')).toBe(process.cwd());
  expect(await readFile(stdinFile, 'utf8')).toContain(CITED);
}, 30000);

it.each([
  ['a duplicated flag', ['--cwd', '.', '--cwd', '.']],
  ['no value', ['--cwd']],
  ['a relative directory', ['--cwd', 'relative/dir']],
  ['a NUL byte', ['--cwd', 'bad\0dir']],
])('rejects --cwd with %s before any spawn', async (_label, cwdArgs) => {
  expect(await run(args(cwdArgs, [`require('node:fs').writeFileSync(${JSON.stringify(marker())},'x')`]))).toBe(2);
  await noChild();
});

it.each([
  ['a missing directory', () => join(root, 'missing')],
  ['a regular file', () => prompt],
])('rejects --cwd pointing at %s before any spawn', async (_label, resolveCwd) => {
  const cwd = resolveCwd();
  expect(await run(args(['--cwd', cwd], [`require('node:fs').writeFileSync(${JSON.stringify(marker())},'x')`]))).toBe(2);
  await noChild();
  expect(err).not.toContain(cwd);
});

it.each([
  ['a relative path', 'relative/dir'],
  ['an empty string', ''],
  ['a NUL byte', 'bad\0dir'],
  ['a non-string value', 42 as unknown as string],
])('rejects runContextWorker cwd of %s before any spawn', async (_label, cwd) => {
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker())},'x')`;
  expect(await runContextWorker({ snapshot, prompt, cwd, argv: [process.execPath, '-e', code] }, io())).toBe(2);
  await noChild();
});

it('rejects runContextWorker cwd that is missing or not a directory before any spawn', async () => {
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker())},'x')`;
  for (const cwd of [join(root, 'missing'), prompt]) {
    expect(await runContextWorker({ snapshot, prompt, cwd, argv: [process.execPath, '-e', code] }, io())).toBe(2);
  }
  await noChild();
});

it('runs concurrent workers in different directories without interference', async () => {
  const dirA = join(root, 'checkout A'), dirB = join(root, 'checkout B');
  await mkdir(dirA); await mkdir(dirB);
  const promptB = join(root, 'prompt-b.txt');
  await writeFile(promptB, 'beta worker prompt\n');
  const fileA = { cwd: join(root, 'a-cwd'), stdin: join(root, 'a-stdin') };
  const fileB = { cwd: join(root, 'b-cwd'), stdin: join(root, 'b-stdin') };
  const [exitA, exitB] = await Promise.all([
    runContextWorker({ snapshot, prompt, cwd: dirA,
      argv: [process.execPath, '-e', recorder, '--', fileA.cwd, fileA.stdin] }, io()),
    runContextWorker({ snapshot, prompt: promptB, cwd: dirB,
      argv: [process.execPath, '-e', recorder, '--', fileB.cwd, fileB.stdin] }, io()),
  ]);
  expect([exitA, exitB]).toEqual([0, 0]);
  expect(await readFile(fileA.cwd, 'utf8')).toBe(realpathSync(dirA));
  expect(await readFile(fileB.cwd, 'utf8')).toBe(realpathSync(dirB));
  const stdinA = await readFile(fileA.stdin, 'utf8'), stdinB = await readFile(fileB.stdin, 'utf8');
  expect(stdinA.startsWith(PROMPT + CONTEXT_START)).toBe(true);
  expect(stdinB.startsWith('beta worker prompt\n' + CONTEXT_START)).toBe(true);
  expect(stdinA).toContain(CITED); expect(stdinB).toContain(CITED);
  expect(stdinA).not.toContain('beta worker prompt'); expect(stdinB).not.toContain('base prompt for cwd test');
}, 30000);

