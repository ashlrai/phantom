import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox, BUS_INBOX_MAX_READ, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { replyHandoffBus } from '../src/core/fleet/handoff-bus-reply.js';

let root: string;
let temp: string;
let snapshot: string;
let marker: string;
const target = { id: 'paged-target', from: 'planner', to: 'worker', priority: 'P3' as const, ttl: 600000,
  body: { kind: 'worker-handoff', taskId: 'PAGED-1', prompt: 'target prompt' } };
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
const bus = () => ({ root: join(root, 'bus') });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paged-handoff-'));
  temp = join(root, 'tmp');
  snapshot = join(root, 'snapshot.json');
  marker = join(root, 'invocations');
  await mkdir(temp, { mode: 0o700 });
  vi.stubEnv('TMPDIR', temp);
  vi.stubEnv('HOME', root);
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'PAGED-1', upstreamJobIds: [] },
    tasks: [{ jobId: 'PAGED-1', text: 'context' }], outputs: [], byteBudget: 8192 }), { mode: 0o600 });
  for (let i = 0; i < BUS_INBOX_MAX_READ + 1; i++) {
    expect(appendBusInbox({ ...target, id: `noise-${i}`, body: { kind: 'noise' } }, bus()).status).toBe('posted');
  }
  expect(appendBusInbox(target, bus()).status).toBe('posted');
}, 180000);
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function run(to: string) {
  return replyHandoffBus({ id: target.id, to, snapshot, replyId: 'paged-exit', spoolDir: join(root, 'spool'),
    timeoutMs: 30000, argv: [process.execPath, '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(marker)},'run\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(7))`] },
  bus(), { stdout: sink(), stderr: sink() });
}
function replies() {
  const first = listBusInboxAfter(0, BUS_INBOX_MAX_READ, bus());
  expect(first.status).toBe('ok');
  if (first.status !== 'ok') throw new Error('inbox unavailable');
  expect(first.messages.some(row => row.envelope.id === target.id)).toBe(false);
  const second = listBusInboxAfter(first.nextCursor, BUS_INBOX_MAX_READ, bus());
  expect(second.status).toBe('ok');
  if (second.status !== 'ok') throw new Error('inbox unavailable');
  return second.messages.filter(row => row.envelope.id === 'paged-exit');
}

it('replies once to the requested handoff beyond the first inbox page', async () => {
  const result = await run(target.to);
  expect(result.workerExit).toEqual({ status: 'returned', exitCode: 7 });
  expect(result.delivery.status).toBe('posted');
  const found = replies();
  expect(found).toHaveLength(1);
  expect(found[0]!.envelope).toMatchObject({ id: 'paged-exit', from: target.to, to: target.from,
    body: { kind: 'worker-exit', inReplyTo: target.id, exitCode: 7, succeeded: false } });
  expect(await readFile(marker, 'utf8')).toBe('run\n');
  expect(await readdir(temp)).toEqual([]);
}, 30000);

it('refuses a wrong recipient after scanning past the first page', async () => {
  const result = await run('other-worker');
  expect(result.workerExit.status).toBe('not-started');
  expect(result.delivery.status).toBe('refused');
  expect(replies()).toHaveLength(0);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(temp)).toEqual([]);
}, 30000);
