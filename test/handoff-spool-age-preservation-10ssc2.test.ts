import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextDeliver } from '../src/cli/fleet-context-deliver.js';
import { cmdFleetContextDrain } from '../src/cli/fleet-context-drain.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { parseBusEnvelope } from '../src/core/fleet/bus-envelope.js';

let root: string, busRoot: string, spoolDir: string, snapshot: string, prompt: string;
let requestFile: string, marker: string, out: string, err: string, now: number;
const TASK = 'TASK-10SSC2';
const REPLY_ID = 'reply-10ssc2';
const REQUEST_ID = 'request-10ssc2';
const REQUEST_TTL = 60000;
/** Bus-clock time consumed by the simulated slow failed publication. */
const PUBLISH_DELAY = 20000;
/** Fully synthetic bus clock: far from Date.now so a wall-clock stamp would
 * read as a rollback, proving the spool honors the injected clock. */
const T0 = 1_000_000;

const sink = (write: (value: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const bus = () => ({ root: busRoot, now: () => now });
const io = () => ({
  stdout: sink(s => { out += s; }),
  stderr: sink(s => {
    err += s;
    // The worker's last stderr byte lands after its exit is certain but before
    // the reply publication attempt: advancing the bus clock here simulates a
    // slow initial publication without sleeping.
    if (s.includes('worker-done')) now += PUBLISH_DELAY;
  }),
});
const records = async () => (await readdir(spoolDir)).filter(name => /^reply-[0-9a-f]{32}\.json$/.test(name)).sort();
const recordPath = async () => join(spoolDir, (await records())[0]!);
const readRecord = async () => JSON.parse(await readFile(await recordPath(), 'utf8')) as {
  wire: string; preparedAt: number; workerExit: { status: string; exitCode: number };
};
const replyRows = () => {
  const page = listBusInboxAfter(0, 50, bus());
  if (page.status !== 'ok') throw new Error('fixture inbox unavailable');
  return page.messages.filter(row => row.envelope.id === REPLY_ID);
};
const drain = () => cmdFleetContextDrain(['--spool-dir', spoolDir, '--json', '--apply'], io(), bus());
const deliverArgs = () => ['--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile,
  '--reply-id', REPLY_ID, '--spool-dir', spoolDir, '--', process.execPath, '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(marker)},'run\\n');` +
  `process.stdin.resume();process.stdin.on('end',()=>process.stderr.write('worker-done\\n',()=>process.exit(0)))`];

/** Run the real delivery path once with the bus inbox writer locked, so the
 * reply publication fails for real and is spooled. Returns the record. */
async function spoolReply() {
  const lock = acquireLocalStoreLock(join(busRoot, 'bus-inbox', 'writer.lock'), 0,
    { anchorPath: busRoot, exactPrivateStorage: true });
  expect(lock).not.toBeNull();
  try {
    now = T0;
    out = ''; err = '';
    expect(await cmdFleetContextDeliver(deliverArgs(), io(), bus())).toBe(1);
  } finally { releaseLocalStoreLock(lock); }
  expect(err).toContain('"workerExit":{"status":"returned","exitCode":0}');
  expect(err).toContain('"delivery":{"status":"pending"');
  expect(await readFile(marker, 'utf8')).toBe('run\n');
  expect(await records()).toHaveLength(1);
  return readRecord();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spool-age-10ssc2-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  busRoot = join(root, 'bus'); spoolDir = join(root, 'spool');
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt');
  requestFile = join(root, 'request.json'); marker = join(root, 'counter');
  out = ''; err = ''; now = T0;
  await writeFile(snapshot, JSON.stringify({ node: { jobId: TASK, upstreamJobIds: [] },
    tasks: [{ jobId: TASK, text: 'synthetic task' }], outputs: [], byteBudget: 8192 }), { mode: 0o600 });
  await writeFile(prompt, 'private prompt', { mode: 0o600 });
  await writeFile(requestFile, JSON.stringify({ id: REQUEST_ID, from: 'planner', to: 'worker',
    priority: 'P2', ttl: REQUEST_TTL, body: { kind: 'context' } }), { mode: 0o600 });
  // Create the private inbox layout so the writer lock path exists.
  expect(appendBusInbox({ id: 'seed-10ssc2', from: 'planner', to: 'worker', priority: 'P2',
    ttl: REQUEST_TTL, body: {} }, { root: busRoot }).status).toBe('posted');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('expires a reply whose original lifetime elapsed during a slow failed publication', async () => {
  const record = await spoolReply();
  const retained = parseBusEnvelope(record.wire);
  expect(retained.ok).toBe(true);
  if (!retained.ok) return;
  // The consumed budget the producer subtracted is recoverable from the wire:
  // request.ttl - reply.ttl. The stamp must equal start + consumed - skew, so
  // the simulated 20 s publication delay never enters the retained deadline.
  const consumed = REQUEST_TTL - retained.value.ttl;
  expect(consumed).toBeGreaterThan(0);
  expect(record.preparedAt).toBe(T0 + consumed - 2);
  expect(record.preparedAt).toBeLessThan(T0 + PUBLISH_DELAY);
  expect(record.preparedAt + retained.value.ttl).toBeLessThanOrEqual(T0 + REQUEST_TTL);
  const path = await recordPath();
  // Advance beyond the original reply lifetime: preparedAt + reply.ttl is the
  // retained deadline, and the request deadline T0 + REQUEST_TTL is already past.
  now = T0 + REQUEST_TTL + PUBLISH_DELAY;
  out = ''; err = '';
  expect(await drain()).toBe(2);
  expect(JSON.parse(out).counts).toEqual({ expired: 1 });
  // Evidence is retained exactly as saved; nothing revived, nothing rerun.
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify(record));
  expect(replyRows()).toHaveLength(0);
  expect(await readFile(marker, 'utf8')).toBe('run\n');
}, 30000);

it('posts once inside the remaining lifetime and dedupes across drains', async () => {
  const record = await spoolReply();
  const retained = parseBusEnvelope(record.wire);
  expect(retained.ok).toBe(true);
  if (!retained.ok) return;
  now = record.preparedAt + 1000;
  out = ''; err = '';
  expect(await drain()).toBe(0);
  expect(JSON.parse(out).counts).toEqual({ posted: 1 });
  const replies = replyRows();
  expect(replies).toHaveLength(1);
  // Admission is backdated to the preparation stamp, so the wire TTL keeps
  // shrinking from the original deadline rather than restarting at retry.
  expect(replies[0]!.receivedAt).toBe(record.preparedAt);
  expect({ ...replies[0]!.envelope, ttl: retained.value.ttl }).toEqual(retained.value);
  out = '';
  expect(await drain()).toBe(0);
  expect(JSON.parse(out).selected).toBe(0);
  expect(replyRows()).toHaveLength(1);
  expect(await readFile(marker, 'utf8')).toBe('run\n');
}, 30000);

it('refuses a retry stamped ahead of the injected bus clock', async () => {
  const record = await spoolReply();
  now = record.preparedAt - 1;
  out = ''; err = '';
  expect(await drain()).toBe(2);
  expect(JSON.parse(out).counts).toEqual({ 'clock-rollback': 1 });
  expect(await records()).toHaveLength(1);
  expect(replyRows()).toHaveLength(0);
  expect(await readFile(marker, 'utf8')).toBe('run\n');
}, 30000);

it('keeps worker outcome reporting when the bus clock is unusable', async () => {
  // A bus clock that throws must not fabricate a fresh lifetime: the fallback
  // stamp is the earliest safe bound and the record stays evidence-only.
  const lock = acquireLocalStoreLock(join(busRoot, 'bus-inbox', 'writer.lock'), 0,
    { anchorPath: busRoot, exactPrivateStorage: true });
  expect(lock).not.toBeNull();
  const brokenBus = { root: busRoot, now: () => { throw new Error('clock down'); } };
  try {
    expect(await cmdFleetContextDeliver(deliverArgs(), io(), brokenBus)).toBe(1);
  } finally { releaseLocalStoreLock(lock); }
  expect(err).toContain('"delivery":{"status":"pending"');
  expect(await records()).toHaveLength(1);
  const record = await readRecord();
  expect(record.preparedAt).toBe(0);
  expect(record.workerExit).toEqual({ status: 'returned', exitCode: 0 });
  // Retry on a working clock reads the epoch-floor stamp as fully elapsed:
  // expired evidence, never a revived post and never a second worker run.
  now = T0;
  out = '';
  expect(await drain()).toBe(2);
  expect(JSON.parse(out).counts).toEqual({ expired: 1 });
  expect(replyRows()).toHaveLength(0);
  expect(await readFile(marker, 'utf8')).toBe('run\n');
}, 30000);
