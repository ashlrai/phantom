import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReply } from '../src/cli/fleet-handoff-reply.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { deliverSpooledContextReply } from '../src/core/fleet/context-reply-spool.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

let root: string, snapshot: string, spool: string, counter: string, temp: string;
let out: string, err: string;
const prompt = 'synthetic private prompt 112';
const context = 'synthetic private context 112';
const bus = () => ({ root: join(root, 'bus') });
const sink = (write: (value: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const io = (onOutput: (value: string) => void = () => {}) => ({
  stdout: sink(s => { out += s; onOutput(s); }), stderr: sink(s => { err += s; }),
});
const args = (script: string) => ['--id', 'request', '--to', 'worker', '--snapshot', snapshot,
  '--reply-id', 'reply', '--spool-dir', spool, '--timeout-ms', '5000', '--',
  process.execPath, '-e', script, counter];
const replies = () => {
  const page = listBusInboxAfter(0, 50, bus());
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  return page.messages.filter(row => row.envelope.id === 'reply');
};
const expected = { id: 'reply', from: 'worker', to: 'planner', priority: 'P2',
  body: { kind: 'worker-exit', inReplyTo: 'request', exitCode: 143, succeeded: false } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reply-cli-cancel-'));
  temp = join(root, 'tmp');
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  vi.stubEnv('TMPDIR', temp);
  await mkdir(temp, { mode: 0o700 });
  snapshot = join(root, 'snapshot.json'); spool = join(root, 'spool'); counter = join(root, 'counter');
  out = ''; err = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'JOB-112', upstreamJobIds: [] },
    tasks: [{ jobId: 'JOB-112', text: context }], outputs: [], byteBudget: 8192 }), { mode: 0o600 });
  expect(appendBusInbox({ id: 'request', from: 'planner', to: 'worker', priority: 'P2', ttl: 60000,
    body: { kind: 'worker-handoff', taskId: 'JOB-112', prompt } }, bus()).status).toBe('posted');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('does not launch a pre-cancelled worker and publishes its correlated failure', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await cmdFleetHandoffReply(args('require("node:fs").writeFileSync(process.argv[1],"run")'),
    bus(), io(), { signal: controller.signal })).toBe(143);
  expect(existsSync(counter)).toBe(false);
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.envelope).toMatchObject(expected);
  expect(await readdir(spool)).toEqual([]);
  expect(await readdir(temp)).toEqual([]);
  expect(err).not.toContain(prompt);
  expect(err).not.toContain(context);
});

it('cancels after consuming stdin and retains the failure for delivery without rerunning', async () => {
  const controller = new AbortController();
  const lock = acquireLocalStoreLock(join(bus().root, 'bus-inbox', 'writer.lock'), 0,
    { anchorPath: bus().root, exactPrivateStorage: true });
  expect(lock).not.toBeNull();
  const fallback = setTimeout(() => controller.abort(), 3000);
  const start = Date.now();
  try {
    const script = 'const fs=require("node:fs");fs.appendFileSync(process.argv[1],"run\\n");' +
      'let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{' +
      `if(!input.includes(${JSON.stringify(prompt)})||!input.includes(${JSON.stringify(context)}))process.exit(9);` +
      'process.stdout.write("ready");setTimeout(()=>process.exit(0),4500)})';
    const code = await cmdFleetHandoffReply(args(script), bus(), io(s => {
      if (s.includes('ready')) controller.abort();
    }), { signal: controller.signal });
    expect(code).toBe(143);
    expect(out).toBe('ready');
    expect(Date.now() - start).toBeLessThan(3000);
  } finally {
    clearTimeout(fallback);
    releaseLocalStoreLock(lock);
  }
  expect(await readFile(counter, 'utf8')).toBe('run\n');
  expect(replies()).toHaveLength(0);
  const names = (await readdir(spool)).filter(name => /^reply-[0-9a-f]{32}\.json$/.test(name));
  expect(names).toHaveLength(1);
  const path = join(spool, names[0]!);
  const record = JSON.parse(await readFile(path, 'utf8')) as { wire: string };
  expect(JSON.parse(record.wire)).toMatchObject(expected);
  expect(err).toContain('"status":"pending"');
  expect(err).not.toContain(prompt);
  expect(err).not.toContain(context);
  expect(deliverSpooledContextReply(path, bus()).delivery.status).toBe('posted');
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.envelope).toMatchObject(expected);
  expect(await readFile(counter, 'utf8')).toBe('run\n');
  expect(await readdir(temp)).toEqual([]);
}, 10000);
