import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { receiveHandoffBus, type HandoffBusReceiveOptions } from '../src/core/fleet/handoff-bus-receive.js';

let root: string, temp: string, snapshot: string, marker: string, stderr: string, stdout: string;
const body = 'fake retained body marker 115';
const sink = (write: (text: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const options = (signal?: AbortSignal): HandoffBusReceiveOptions => ({
  id: 'message-115', to: 'worker-115', snapshot, signal,
  argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.stdin.resume(); process.stdin.on('end', () => { console.log('ready'); setInterval(() => {}, 1000); });`],
});
const receive = (opts: HandoffBusReceiveOptions, onOutput = (_text: string) => {}) =>
  receiveHandoffBus(opts, { root: join(root, 'bus') }, {
    stdout: sink(text => { stdout += text; onOutput(text); }),
    stderr: sink(text => { stderr += text; }),
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'receive-abort-115-'));
  temp = join(root, 'tmp'); snapshot = join(root, 'snapshot.json'); marker = join(root, 'child');
  stdout = ''; stderr = '';
  await mkdir(temp);
  vi.stubEnv('TMPDIR', temp);
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'WORK-115', upstreamJobIds: [] },
    tasks: [{ jobId: 'WORK-115', text: 'fake snapshot' }], outputs: [], byteBudget: 8192 }));
  expect(appendBusInbox({ id: 'message-115', from: 'planner', to: 'worker-115', priority: 'P3',
    ttl: 86400000, body: { kind: 'worker-handoff', taskId: 'WORK-115', prompt: body } },
  { root: join(root, 'bus') }).status).toBe('posted');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('rejects an invalid signal before staging or spawning', async () => {
  expect(await receive(options({} as AbortSignal))).toBe(2);
  expect(stderr).toContain('invalid input');
  expect(stderr).not.toContain(body);
  expect(existsSync(marker)).toBe(false);
  expect(await readdir(temp)).toEqual([]);
});

it('does not spawn or stage a pre-aborted receive', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await receive(options(controller.signal))).toBe(143);
  expect(stderr).toContain('worker launch aborted');
  expect(stderr).not.toContain(body);
  expect(existsSync(marker)).toBe(false);
  expect(await readdir(temp)).toEqual([]);
});

it('cleans up when cancellation arrives during temporary workspace preparation', async () => {
  const controller = new AbortController();
  const pending = receive(options(controller.signal));
  queueMicrotask(() => controller.abort());
  expect(await pending).toBe(143);
  expect(existsSync(marker)).toBe(false);
  expect(stderr).not.toContain(body);
  expect(await readdir(temp)).toEqual([]);
});

it('terminates the active child and removes retained inputs', async () => {
  const controller = new AbortController();
  const fallback = setTimeout(() => controller.abort(), 5000);
  try {
    expect(await receive(options(controller.signal), text => { if (text.includes('ready')) controller.abort(); })).toBe(143);
    expect(stdout).toContain('ready');
    expect(existsSync(marker)).toBe(true);
    expect(stderr).not.toContain(body);
    expect(await readdir(temp)).toEqual([]);
  } finally { clearTimeout(fallback); }
}, 15000);

it('preserves normal success and removes retained inputs', async () => {
  const opts = options();
  opts.argv = [process.execPath, '-e', 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(s.includes("fake retained body marker 115") && s.includes("fake snapshot")))'];
  expect(await receive(opts)).toBe(0);
  expect(stdout).toContain('true');
  expect(stderr).not.toContain(body);
  expect(await readdir(temp)).toEqual([]);
});
