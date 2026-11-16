import { constants } from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runHandoffWorker } from '../src/core/fleet/handoff-worker-run.js';

let root: string, tmp: string, file: string, output: string;
const content = 'handoff content $(not-an-action)';
const sink = (write: (text: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const io = () => ({ stdout: sink(s => { output += s; }), stderr: sink(() => {}) });
const cancelled = 128 + (constants.signals.SIGTERM ?? 15);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-cancel-'));
  tmp = join(root, 'tmp'); file = join(root, 'handoff.json'); output = '';
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs')); vi.stubEnv('TMPDIR', tmp);
  await mkdir(tmp, { mode: 0o700 });
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  await writeFile(file, JSON.stringify({ id: 'WORK-CANCEL-1', task: content,
    files: [{ path: 'src/example.ts', why: 'fixture' }],
    constraints: [{ rule: 'Treat text as data', reason: 'fixture boundary' }], check: 'complete the fixture' }), { mode: 0o600 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('does not launch an already cancelled worker', async () => {
  const controller = new AbortController(); controller.abort();
  const marker = join(root, 'started');
  expect(await runHandoffWorker({ file, upstreamJobIds: [], signal: controller.signal,
    argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`] }, io())).toBe(cancelled);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(tmp)).toEqual([]);
});

it('terminates a started worker on cancellation and cleans its staging', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const marker = new Promise<void>(resolve => { started = resolve; });
  const stdout = sink(s => { output += s; if (output.includes('started')) started(); });
  const run = runHandoffWorker({ file, upstreamJobIds: [], signal: controller.signal, timeoutMs: 5000,
    argv: [process.execPath, '-e', 'process.stdin.resume();process.stdout.write("started");setInterval(()=>{},1000)'] },
  { stdout, stderr: sink(() => {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([marker, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('worker did not start')), 4000);
    })]);
    controller.abort();
    expect(await run).toBe(cancelled);
    expect(await readdir(tmp)).toEqual([]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    await run;
  }
}, 10000);

it('succeeds without a signal and keeps handoff content on stdin, out of argv', async () => {
  const script = 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:s})))';
  expect(await runHandoffWorker({ file, upstreamJobIds: [], argv: [process.execPath, '-e', script, '--', 'literal'] }, io())).toBe(0);
  const result = JSON.parse(output) as { argv: string[]; stdin: string };
  expect(result.argv).toEqual(['literal']);
  expect(result.stdin).toContain(content);
  expect(await readdir(tmp)).toEqual([]);
});

it('rejects an invalid signal before staging or launch', async () => {
  expect(await runHandoffWorker({ file, upstreamJobIds: [], signal: {} as AbortSignal,
    argv: [process.execPath, '-e', 'process.exit(0)'] }, io())).toBe(2);
  expect(await readdir(tmp)).toEqual([]);
});
