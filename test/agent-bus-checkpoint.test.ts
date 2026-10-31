import { afterEach, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBusCheckpoint,
  type BusCheckpointDependencies,
  type BusCheckpointFile,
} from '../examples/agents/bus-checkpoint.js';
import { appendBusInbox, type BusInboxPage } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'bus-checkpoint-'));
  roots.push(home);
  return { home, root: join(home, 'fleet'), checkpoint: join(home, 'fake.checkpoint.json') };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function post(root: string, id: string, to: string, ttl = 100_000, now = 0) {
  expect(appendBusInbox({ id, from: 'fake-a', to, priority: 'P2', ttl, body: { text: 'untrusted data' } },
    { root, now: () => now }).status).toBe('posted');
}
function fakeReceipt(id: string, to: string, cursor: number) {
  const envelope: BusEnvelope = { id, from: 'fake-a', to, priority: 'P2', ttl: 1_000, body: { text: 'untrusted data' } };
  return { cursor, receivedAt: 0, envelope };
}
function writeCheckpoint(path: string, checkpoint: Partial<BusCheckpointFile>) {
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, to: 'fake-b', cursor: 0, updatedAt: 0, ...checkpoint })}\n`,
    { mode: 0o600 });
}
const readCheckpoint = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as BusCheckpointFile;
const messageIds = (stdout: string) =>
  (JSON.parse(stdout).messages as { envelope: BusEnvelope }[]).map(row => row.envelope.id);

async function run(args: string[], root: string, extra: BusCheckpointDependencies = {}, now = 100) {
  let stdout = '', stderr = '';
  const code = await runBusCheckpoint(args, {
    ...extra,
    options: { root, now: () => now },
    now: extra.now ?? (() => now),
    stdout: extra.stdout ?? (text => { stdout += text; }),
    stderr: extra.stderr ?? (text => { stderr += text; }),
  });
  return { code, stdout, stderr };
}

it('resumes from the persisted checkpoint across restarts without skipping or replaying', async () => {
  const { root, checkpoint } = setup();
  post(root, 'one', 'fake-b');
  post(root, 'noise', 'fake-c');
  post(root, 'two', 'fake-b');
  const first = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(first).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(first.stdout)).toMatchObject({ status: 'ok', to: 'fake-b', resumedFrom: 0, nextCursor: 3 });
  expect(messageIds(first.stdout)).toEqual(['one', 'two']);
  expect(readCheckpoint(checkpoint)).toMatchObject({ schemaVersion: 1, to: 'fake-b', cursor: 3 });
  post(root, 'three', 'fake-b');
  const second = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(JSON.parse(second.stdout)).toMatchObject({ resumedFrom: 3, nextCursor: 4 });
  expect(messageIds(second.stdout)).toEqual(['three']);
  expect(readCheckpoint(checkpoint).cursor).toBe(4);
  const third = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(JSON.parse(third.stdout)).toMatchObject({ resumedFrom: 4, nextCursor: 4, messages: [] });
}, 30_000);

it('preserves the old checkpoint when the output sink fails', async () => {
  const { root, checkpoint } = setup();
  post(root, 'one', 'fake-b');
  post(root, 'two', 'fake-b');
  expect(await run(['--to', 'fake-b', '--checkpoint', checkpoint], root)).toMatchObject({ code: 0 });
  const before = readFileSync(checkpoint, 'utf8');
  post(root, 'three', 'fake-b');
  const failed = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root, {
    stdout: () => { throw new Error('fake sink closed'); },
  });
  expect(failed).toEqual({ code: 5, stdout: '', stderr: '{"status":"output-failed"}\n' });
  expect(readFileSync(checkpoint, 'utf8')).toBe(before);

  const second = setup();
  post(second.root, 'fresh', 'fake-b');
  const fresh = await run(['--to', 'fake-b', '--checkpoint', second.checkpoint], second.root, {
    stdout: () => { throw new Error('fake sink closed'); },
  });
  expect(fresh.code).toBe(5);
  expect(existsSync(second.checkpoint)).toBe(false);
}, 30_000);

it('advances and persists the cursor across empty filtered pages', async () => {
  const { root, checkpoint } = setup();
  post(root, 'other-1', 'fake-c');
  post(root, 'other-2', 'fake-c');
  post(root, 'other-3', 'fake-c');
  const first = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ resumedFrom: 0, nextCursor: 3, messages: [] });
  expect(readCheckpoint(checkpoint)).toMatchObject({ to: 'fake-b', cursor: 3 });
  post(root, 'late', 'fake-b');
  const second = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(JSON.parse(second.stdout)).toMatchObject({ resumedFrom: 3, nextCursor: 4 });
  expect(messageIds(second.stdout)).toEqual(['late']);
}, 30_000);

it('refuses malformed or mismatched checkpoints instead of resetting to zero', async () => {
  const { root, checkpoint } = setup();
  post(root, 'one', 'fake-b');
  for (const text of [
    'not-json',
    '{"cursor":0}',
    '[]',
    '{"schemaVersion":1,"to":"fake-b","cursor":0,"updatedAt":0,"extra":1}',
    '{"schemaVersion":2,"to":"fake-b","cursor":0,"updatedAt":0}',
    '{"schemaVersion":1,"to":"fake-b","cursor":-1,"updatedAt":0}',
    '{"schemaVersion":1,"to":"fake-b","cursor":1.5,"updatedAt":0}',
    '{"schemaVersion":1,"to":"fake-b","cursor":"0","updatedAt":0}',
    '{"schemaVersion":1,"to":"fake-b","cursor":0,"updatedAt":null}',
  ]) {
    writeFileSync(checkpoint, text, { mode: 0o600 });
    expect(await run(['--to', 'fake-b', '--checkpoint', checkpoint], root), text.slice(0, 40)).toEqual({
      code: 3, stdout: '', stderr: '{"status":"checkpoint-malformed"}\n',
    });
    expect(readFileSync(checkpoint, 'utf8')).toBe(text);
  }
  writeCheckpoint(checkpoint, { to: 'fake-c' });
  expect(await run(['--to', 'fake-b', '--checkpoint', checkpoint], root))
    .toEqual({ code: 3, stdout: '', stderr: '{"status":"checkpoint-mismatch"}\n' });
  writeCheckpoint(checkpoint, { cursor: 99 });
  expect(await run(['--to', 'fake-b', '--checkpoint', checkpoint], root))
    .toEqual({ code: 3, stdout: '', stderr: '{"status":"checkpoint-stale"}\n' });
  const directoryPath = join(root, '..', 'fake-dir-checkpoint');
  mkdirSync(directoryPath);
  expect(await run(['--to', 'fake-b', '--checkpoint', directoryPath], root))
    .toEqual({ code: 3, stdout: '', stderr: '{"status":"checkpoint-unavailable"}\n' });
  writeFileSync(checkpoint, 'x'.repeat(5000), { mode: 0o600 });
  expect(await run(['--to', 'fake-b', '--checkpoint', checkpoint], root))
    .toEqual({ code: 3, stdout: '', stderr: '{"status":"checkpoint-unavailable"}\n' });
  chmodSync(root, 0o777);
  try {
    expect(await run(['--to', 'fake-b', '--checkpoint', join(root, 'fake.checkpoint.json')], root))
      .toEqual({ code: 3, stdout: '', stderr: '{"status":"checkpoint-unavailable"}\n' });
  } finally {
    chmodSync(root, 0o700);
  }
  // A refused run keeps position: the repaired file resumes at its own cursor, never zero.
  writeCheckpoint(checkpoint, { cursor: 1 });
  const repaired = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(JSON.parse(repaired.stdout)).toMatchObject({ resumedFrom: 1, nextCursor: 1, messages: [] });
}, 30_000);

it('leaves a readable old or new checkpoint when the atomic write is interrupted', async () => {
  const { root, checkpoint } = setup();
  post(root, 'one', 'fake-b');
  writeCheckpoint(checkpoint, { cursor: 0 });
  const before = readFileSync(checkpoint, 'utf8');
  const crashed = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root, {
    saveCheckpoint: path => {
      writeFileSync(`${path}.pending-fake`, 'partial-garbage');
      throw new Error('fake crash before rename');
    },
  });
  expect(crashed.code).toBe(4);
  expect(crashed.stderr).toBe('{"status":"checkpoint-write-failed"}\n');
  // The page was emitted, so at-least-once replay applies: the old file is still readable.
  expect(JSON.parse(crashed.stdout)).toMatchObject({ status: 'ok', nextCursor: 1 });
  expect(readFileSync(checkpoint, 'utf8')).toBe(before);
  // A stranded pending file never blocks the next atomic write or the resume read.
  const recovered = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(recovered.code).toBe(0);
  expect(readCheckpoint(checkpoint)).toMatchObject({ to: 'fake-b', cursor: 1 });
  expect(existsSync(`${checkpoint}.pending-fake`)).toBe(false);
}, 30_000);

it('waits within a bounded budget, then emits and persists once', async () => {
  const { root, checkpoint } = setup();
  const pages: BusInboxPage[] = [
    { status: 'ok', messages: [fakeReceipt('noise', 'fake-c', 1)], nextCursor: 1 },
    { status: 'ok', messages: [], nextCursor: 3 },
    { status: 'ok', messages: [fakeReceipt('match', 'fake-b', 4)], nextCursor: 4 },
  ];
  const waits: number[] = [];
  const clock = { value: 0 };
  const saved: BusCheckpointFile[] = [];
  const result = await run(['--to', 'fake-b', '--checkpoint', checkpoint, '--wait', '60000'], root, {
    read: () => pages.shift() ?? { status: 'ok', messages: [], nextCursor: 4 },
    wait: async milliseconds => { waits.push(milliseconds); clock.value += milliseconds; },
    now: () => clock.value,
    saveCheckpoint: (_path, file) => { saved.push(file); },
  });
  expect(result.code).toBe(0);
  expect(waits).toEqual([250, 250]);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ok', resumedFrom: 0, nextCursor: 4, waitedMs: 500 });
  expect(messageIds(result.stdout)).toEqual(['match']);
  expect(saved).toEqual([{ schemaVersion: 1, to: 'fake-b', cursor: 4, updatedAt: 500 }]);
}, 30_000);

it('stops a bounded wait on an interrupt and leaves the checkpoint untouched', async () => {
  const { root, checkpoint } = setup();
  let detachCount = 0;
  let interrupt: (() => void) | undefined;
  const result = await run(['--to', 'fake-b', '--checkpoint', checkpoint, '--wait', '60000'], root, {
    read: () => ({ status: 'ok', messages: [], nextCursor: 7 }),
    wait: async () => { interrupt?.(); },
    onInterrupt: handler => {
      interrupt = handler;
      return () => { detachCount += 1; };
    },
  });
  expect(result).toEqual({ code: 130, stdout: '', stderr: '{"status":"aborted"}\n' });
  expect(detachCount).toBe(1);
  expect(existsSync(checkpoint)).toBe(false);
}, 30_000);

it('reports an unavailable inbox without emitting or persisting', async () => {
  const { root, checkpoint } = setup();
  mkdirSync(join(root, 'bus-inbox'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), 'fake-corrupt-data', { mode: 0o600 });
  const result = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(result).toEqual({ code: 1, stdout: '', stderr: '{"status":"inbox-unavailable"}\n' });
  expect(existsSync(checkpoint)).toBe(false);
  const thrown = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root, {
    read: () => { throw new Error('fake-private-detail'); },
  });
  expect(thrown).toEqual({ code: 1, stdout: '', stderr: '{"status":"inbox-unavailable"}\n' });
}, 30_000);

it('rejects malformed arguments without touching the checkpoint', async () => {
  const { root, checkpoint } = setup();
  writeCheckpoint(checkpoint, { cursor: 0 });
  const before = readFileSync(checkpoint, 'utf8');
  for (const args of [
    [], ['--to'], ['--to', 'fake-b'], ['--checkpoint', checkpoint],
    ['--to', '', '--checkpoint', checkpoint], ['--to', 'bad address', '--checkpoint', checkpoint],
    ['--to', 'fake-b', '--checkpoint', 'relative/checkpoint.json'],
    ['--to', 'fake-b', '--checkpoint', '/tmp/..'],
    ['--to', 'fake-b', '--checkpoint', checkpoint, '--limit', '0'],
    ['--to', 'fake-b', '--checkpoint', checkpoint, '--limit', '101'],
    ['--to', 'fake-b', '--checkpoint', checkpoint, '--limit', '1.5'],
    ['--to', 'fake-b', '--checkpoint', checkpoint, '--wait', '-1'],
    ['--to', 'fake-b', '--checkpoint', checkpoint, '--wait', '60001'],
    ['--to', 'fake-b', '--checkpoint', checkpoint, '--to', 'fake-c'],
    ['--to', 'fake-b', '--bogus', 'x', '--checkpoint', checkpoint],
    ['--to', 'fake-b', '--checkpoint'],
  ]) {
    expect(await run(args, root), JSON.stringify(args)).toEqual({
      code: 2, stdout: '', stderr: '{"status":"invalid-arguments"}\n',
    });
  }
  expect(readFileSync(checkpoint, 'utf8')).toBe(before);
}, 30_000);

it('round-trips the checkpoint file on disk for a later consumer', async () => {
  const { root, checkpoint } = setup();
  post(root, 'via-file', 'fake-b');
  const first = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(first.code).toBe(0);
  const onDisk = readFileSync(checkpoint, 'utf8');
  expect(JSON.parse(onDisk)).toMatchObject({ schemaVersion: 1, to: 'fake-b', cursor: 1, updatedAt: 100 });
  // A second consumer reading the same file resumes exactly where the first stopped.
  post(root, 'after-persist', 'fake-b');
  const second = await run(['--to', 'fake-b', '--checkpoint', checkpoint], root);
  expect(JSON.parse(second.stdout)).toMatchObject({ resumedFrom: 1, nextCursor: 2 });
  expect(messageIds(second.stdout)).toEqual(['after-persist']);
}, 30_000);
