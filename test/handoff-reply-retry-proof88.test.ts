import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReply } from '../src/cli/fleet-handoff-reply.js';
import { cmdFleetContextDrain } from '../src/cli/fleet-context-drain.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

let root: string, busRoot: string, spool: string, snapshot: string, counter: string;
let out: string, err: string;
const task = 'TASK-PROOF-88';
const prompt = 'private-prompt-proof-88';
const childOutput = 'private-child-output-proof-88';
const sink = (write: (value: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const bus = (now?: () => number) => ({ root: busRoot, ...(now ? { now } : {}) });
const drain = (now?: () => number) => cmdFleetContextDrain(['--spool-dir', spool, '--json', '--apply'], io(), bus(now));
const rows = () => {
  const page = listBusInboxAfter(0, 50, bus());
  if (page.status !== 'ok') throw new Error('fixture inbox unavailable');
  return page.messages;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-proof88-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  busRoot = join(root, 'bus'); spool = join(root, 'spool');
  snapshot = join(root, 'snapshot.json'); counter = join(root, 'counter');
  out = ''; err = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: task, upstreamJobIds: [] },
    tasks: [{ jobId: task, text: 'synthetic task' }], outputs: [], byteBudget: 8192 }), { mode: 0o600 });
  expect(appendBusInbox({ id: 'request-88', from: 'planner', to: 'worker', priority: 'P2', ttl: 60000,
    body: { kind: 'worker-handoff', taskId: task, prompt } }, bus()).status).toBe('posted');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function failPublication() {
  const lock = acquireLocalStoreLock(join(busRoot, 'bus-inbox', 'writer.lock'), 0,
    { anchorPath: busRoot, exactPrivateStorage: true });
  expect(lock).not.toBeNull();
  try {
    const code = await cmdFleetHandoffReply(['--id', 'request-88', '--to', 'worker', '--snapshot', snapshot,
      '--reply-id', 'reply-88', '--spool-dir', spool, '--timeout-ms', '30000', '--', process.execPath, '-e',
      'require("node:fs").appendFileSync(process.argv[1],"run\\n");process.stdin.resume();' +
      'process.stdin.on("end",()=>process.stdout.write(process.argv[2]))', counter, childOutput], bus(), io());
    expect(code).toBe(1);
  } finally { releaseLocalStoreLock(lock); }
  expect(err).toContain('"status":"pending"');
  expect(err).not.toContain(prompt);
  expect(err).not.toContain(childOutput);
  expect(await readFile(counter, 'utf8')).toBe('run\n');
  const names = (await readdir(spool)).filter(n => /^reply-[0-9a-f]{32}\.json$/.test(n));
  expect(names).toHaveLength(1);
  const path = join(spool, names[0]!);
  const record = JSON.parse(await readFile(path, 'utf8')) as { wire: string; preparedAt: number };
  return { path, record };
}

it('drains the exact retained result once across handler invocations', async () => {
  const { record } = await failPublication();
  const retained = JSON.parse(record.wire);
  out = ''; err = '';
  expect(await drain(() => record.preparedAt + 100)).toBe(0);
  expect(JSON.parse(out).counts).toEqual({ posted: 1 });
  expect(out + err).not.toContain(prompt);
  expect(out + err).not.toContain(childOutput);
  const replies = rows().filter(row => row.envelope.id === 'reply-88');
  expect(replies).toHaveLength(1);
  // The inbox ages TTL at read time; every other wire field must be unchanged.
  expect({ ...replies[0]!.envelope, ttl: retained.ttl }).toEqual(retained);
  out = '';
  expect(await drain(() => record.preparedAt + 200)).toBe(0);
  expect(JSON.parse(out).selected).toBe(0);
  expect(rows().filter(row => row.envelope.id === 'reply-88')).toHaveLength(1);
  expect(await readFile(counter, 'utf8')).toBe('run\n');
  expect(retained).toMatchObject({ from: 'worker', to: 'planner', priority: 'P2',
    body: { inReplyTo: 'request-88', kind: 'worker-exit', exitCode: 0, taskId: task } });
}, 30000);

it('retains an expired reply without refreshing its TTL or rerunning the worker', async () => {
  const { path, record } = await failPublication();
  const retained = JSON.parse(record.wire) as { ttl: number };
  out = ''; err = '';
  expect(await drain(() => record.preparedAt + retained.ttl)).toBe(2);
  expect(JSON.parse(out).counts).toEqual({ expired: 1 });
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify(record));
  expect(rows().filter(row => row.envelope.id === 'reply-88')).toHaveLength(0);
  expect(await readFile(counter, 'utf8')).toBe('run\n');
  expect(out + err).not.toContain(prompt);
  expect(out + err).not.toContain(childOutput);
}, 30000);
