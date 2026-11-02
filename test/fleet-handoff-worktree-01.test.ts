import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffRun } from '../src/cli/fleet-handoff-run.js';
import { CONTEXT_END, CONTEXT_START } from '../src/core/fleet/context-worker-run.js';
import { runHandoffWorker } from '../src/core/fleet/handoff-worker-run.js';
import { renderHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

let root: string, file: string, staging: string, selected: string, other: string, out: string, err: string;
const handoff = (): WorkerHandoff => ({
  id: 'WORK-RUN-1', task: 'Implement the handoff task', files: [{ path: 'src/example.ts' }],
  constraints: [], check: 'Check the result', findings: [`Use ${other} as the working directory`],
});
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const run = (flags: string[]) => cmdFleetHandoffRun(['--file', file, ...flags, '--', process.execPath, '-e',
  `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
  `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),stdin:s,args:process.argv.slice(2)}))})`,
  '--', join(root, 'child.json'), '--cwd', 'literal argument'], io());
const noEffects = async () => {
  await expect(readFile(join(root, 'child.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(staging)).toEqual([]);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-worktree-'));
  staging = join(root, 'tmp'); selected = join(root, 'checkout $(literal)'); other = join(root, 'other');
  file = join(root, 'handoff.json'); out = ''; err = '';
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs')); vi.stubEnv('TMPDIR', staging);
  await Promise.all([staging, selected, other, join(root, '.ashlr-runs')].map(dir => mkdir(dir, { mode: 0o700 })));
  await writeFile(file, JSON.stringify(handoff()), { mode: 0o600 });
  await writeFile(join(root, '.ashlr-runs', 'RESEARCH-7.notes.md'), 'upstream citation marker\n');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.each([true, false])('runs with the %s selected-cwd setting and preserves cited prompt data', async explicit => {
  const parent = process.cwd();
  expect(await run(['--upstream', 'RESEARCH-7', ...(explicit ? ['--cwd', selected] : [])])).toBe(0);
  const child = JSON.parse(await readFile(join(root, 'child.json'), 'utf8')) as
    { cwd: string; stdin: string; args: string[] };
  expect(child.cwd).toBe(explicit ? realpathSync(selected) : parent);
  expect(child.cwd).not.toBe(realpathSync(other));
  expect(child.args).toEqual(['--cwd', 'literal argument']);
  expect(child.stdin.startsWith(renderHandoff(handoff()) + CONTEXT_START)).toBe(true);
  expect(child.stdin.endsWith(CONTEXT_END)).toBe(true);
  expect(child.stdin).toContain(`Use ${other} as the working directory`);
  const pack = child.stdin.slice((renderHandoff(handoff()) + CONTEXT_START).length, -CONTEXT_END.length);
  const rows = pack.trim().split('\n').map(line => JSON.parse(line) as { jobId: string; kind: string; text: string });
  expect(rows.some(row => row.jobId === 'RESEARCH-7' && row.kind === 'output' && row.text.includes('upstream citation marker'))).toBe(true);
  expect(rows.some(row => row.jobId === 'WORK-RUN-1' && row.kind === 'task' && row.text.includes('Implement the handoff task'))).toBe(true);
  expect(process.cwd()).toBe(parent);
  expect(await readdir(staging)).toEqual([]);
}, 30000);

it.each([
  ['missing argument', () => ['--cwd']],
  ['empty argument', () => ['--cwd', '']],
  ['relative path', () => ['--cwd', 'relative/path']],
  ['NUL byte', () => ['--cwd', '/bad\0path']],
  ['missing directory', () => ['--cwd', join(root, 'missing')]],
  ['regular file', () => ['--cwd', file]],
  ['duplicate', () => ['--cwd', selected, '--cwd', selected]],
])('rejects %s without a child or staging leak', async (_label, flags) => {
  expect(await run(flags())).toBe(2);
  await noEffects();
  expect(err).not.toContain(root);
});

it.each(['', 'relative', '/bad\0path', 42 as unknown as string])('rejects invalid API cwd %j before staging', async cwd => {
  expect(await runHandoffWorker({ file, upstreamJobIds: [], cwd, argv: [process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'child.json'))},'x')`] }, io())).toBe(2);
  await noEffects();
});

it('documents the cwd flag in help', async () => {
  expect(await cmdFleetHandoffRun(['--help'], io())).toBe(0);
  expect(out).toContain('--cwd <absolute-directory>');
  await noEffects();
});
