import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReply } from '../src/cli/fleet-handoff-reply.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { replyHandoffBus, type HandoffBusReplyOptions } from '../src/core/fleet/handoff-bus-reply.js';

let root: string, snapshot: string, spoolDir: string, cwd: string, marker: string;
let output: string;
const sink = (write: (s: string) => void = () => {}) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const bus = () => ({ root: join(root, 'bus') });
const io = (onOutput: (s: string) => void = () => {}) => ({
  stdout: sink(s => { output += s; onOutput(s); }), stderr: sink(),
});
const opts = (argv: string[]): HandoffBusReplyOptions => ({
  id: 'request', to: 'worker', replyId: 'reply', snapshot, spoolDir, timeoutMs: 5000, argv,
});
const post = () => appendBusInbox({ id: 'request', from: 'planner', to: 'worker', priority: 'P3', ttl: 60000,
  body: { kind: 'worker-handoff', taskId: 'JOB-1', prompt: 'fixture' } }, bus());
const replyBody = () => {
  const page = listBusInboxAfter(0, 50, bus());
  return page.status === 'ok' ? page.messages.find(row => row.envelope.id === 'reply')?.envelope.body : undefined;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reply-control-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  await mkdir(join(root, 'runs'), { mode: 0o700 });
  await mkdir(join(root, 'tmp'), { mode: 0o700 });
  cwd = join(root, 'selected');
  await mkdir(cwd);
  snapshot = join(root, 'snapshot.json');
  spoolDir = join(root, 'spool');
  marker = join(root, 'started');
  output = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'JOB-1', upstreamJobIds: [] },
    tasks: [], outputs: [], byteBudget: 8192 }), { mode: 0o600 });
  expect(post().status).toBe('posted');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('handoff reply execution controls', () => {
  it('runs in the selected directory and delivers the reply', async () => {
    const result = await replyHandoffBus({ ...opts([process.execPath, '-e',
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(process.cwd()))']), cwd }, bus(), io());
    expect(result.workerExit).toEqual({ status: 'returned', exitCode: 0 });
    expect(result.delivery.status).toBe('posted');
    expect(await realpath(output)).toBe(await realpath(cwd));
    expect(replyBody()).toMatchObject({ kind: 'worker-exit', exitCode: 0, succeeded: true });
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
  });

  it('rejects an invalid directory before spawning', async () => {
    const result = await replyHandoffBus({ ...opts([process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`]), cwd: join(root, 'missing') }, bus(), io());
    expect(result.workerExit).toEqual({ status: 'returned', exitCode: 2 });
    expect(existsSync(marker)).toBe(false);
    expect(replyBody()).toMatchObject({ exitCode: 2, succeeded: false });
  });

  it('does not spawn on a pre-aborted signal and reports the runner outcome', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await replyHandoffBus({ ...opts([process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`]), signal: controller.signal }, bus(), io());
    expect(result.workerExit).toEqual({ status: 'returned', exitCode: 143 });
    expect(existsSync(marker)).toBe(false);
    expect(replyBody()).toMatchObject({ exitCode: 143, succeeded: false });
  });

  it('cancels a live worker and publishes its non-success exit', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const fallback = setTimeout(() => controller.abort(), 2500);
    try {
      const result = await replyHandoffBus({ ...opts([process.execPath, '-e',
        'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("ready");setTimeout(()=>process.exit(9),4000)})']),
      signal: controller.signal }, bus(), io(s => { if (s.includes('ready')) controller.abort(); }));
      expect(output).toContain('ready');
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result.workerExit).toEqual({ status: 'returned', exitCode: 143 });
      expect(result.delivery.status).toBe('posted');
      expect(replyBody()).toMatchObject({ exitCode: 143, succeeded: false });
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    } finally { clearTimeout(fallback); }
  });

  it('parses --cwd through the CLI and rejects relative and duplicate values', async () => {
    const base = ['--id', 'request', '--to', 'worker', '--snapshot', snapshot, '--reply-id', 'reply',
      '--spool-dir', spoolDir, '--timeout-ms', '5000'];
    const child = ['--', process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(process.cwd()))'];
    expect(await cmdFleetHandoffReply([...base, '--cwd', 'relative', ...child], bus(), io())).toBe(2);
    expect(await cmdFleetHandoffReply([...base, '--cwd', cwd, '--cwd', cwd, ...child], bus(), io())).toBe(2);
    expect(await cmdFleetHandoffReply([...base, '--cwd', cwd, ...child], bus(), io())).toBe(0);
    expect(await realpath(output)).toBe(await realpath(cwd));
  });
});
