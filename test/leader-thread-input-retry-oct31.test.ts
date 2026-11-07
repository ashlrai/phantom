import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendMasonMessage, leaderThreadPath, setLeaderThreadDepsForTest } from '../src/core/vision/leader-thread.js';
import { leaderRoot } from '../src/core/vision/leader-memo.js';
import type { LeaderRunDeps } from '../src/core/vision/leader.js';
import * as storage from '../src/core/verse/preferences.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';

const fake = vi.hoisted(() => ({ complete: vi.fn(), evidence: vi.fn() }));
vi.mock('../src/core/vision/leader-seat.js', () => ({
  resolveLeaderSeat: async () => ({ ok: true, complete: fake.complete, choice: { engine: 'local', seatId: 'fake' } }),
}));
vi.mock('../src/core/vision/leader.js', () => ({
  gatherLeaderEvidence: fake.evidence,
  readLeaderRunState: () => ({}),
}));
const home = useTmpHome();
const opts = { channel: 'cli' as const, sourceEventId: 'fake-event-1' };
const install = () => setLeaderThreadDepsForTest({ loadRunDeps: async () => ({}) as LeaderRunDeps });
const rows = () => readFileSync(leaderThreadPath(), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
beforeEach(() => {
  home.setup();
  fake.complete.mockReset().mockResolvedValue('{"reply":"A fake reply."}');
  fake.evidence.mockResolvedValue(null);
  install();
});
afterEach(() => {
  vi.restoreAllMocks();
  setLeaderThreadDepsForTest(null);
  home.teardown();
});

it('overlapping retries return the acceptance pending, then reuse the completed reply', async () => {
  let release!: (s: string) => void;
  fake.complete.mockImplementation(() => new Promise<string>((resolve) => { release = resolve; }));
  const first = appendMasonMessage('Hello', opts);
  await vi.waitFor(() => expect(fake.complete).toHaveBeenCalledTimes(1));
  const pending = await appendMasonMessage('Hello', opts);
  expect(pending.outcome).toBe('pending');
  expect(pending.reply).toBeNull();
  release('{"reply":"A fake reply."}');
  const completed = await first;
  expect(completed.outcome).toBe('completed');
  expect(completed.message).toEqual(pending.message);
  install(); // Simulate fresh process dependencies: receipts are on disk.
  expect(await appendMasonMessage('Hello', opts)).toEqual(completed);
  expect(rows()).toHaveLength(2);
  expect(fake.complete).toHaveBeenCalledTimes(1);
});

it('legacy calls remain independent and keep their result shape', async () => {
  const a = await appendMasonMessage('Hello', { channel: 'cli' });
  const b = await appendMasonMessage('Hello', { channel: 'cli' });
  expect(a.outcome).toBeUndefined();
  expect(a.message.id).not.toBe(b.message.id);
  expect(fake.complete).toHaveBeenCalledTimes(2);
});

it('separates channels and distinct event IDs without deduping text', async () => {
  await appendMasonMessage('Hello', opts);
  await appendMasonMessage('Hello', { ...opts, channel: 'telegram' });
  await appendMasonMessage('Hello', { ...opts, sourceEventId: 'fake-event-2' });
  expect(rows()).toHaveLength(6);
  expect(fake.complete).toHaveBeenCalledTimes(3);
});

it('rejects conflicting text, reply target and record-only mode', async () => {
  const a = await appendMasonMessage('Hello', opts);
  for (const [text, options] of [
    ['Changed', opts], ['Hello', { ...opts, replyTo: a.message.id }], ['Hello', { ...opts, recordOnly: true }],
  ] as const) await expect(appendMasonMessage(text, options)).rejects.toMatchObject({ code: 409 });
  expect(fake.complete).toHaveBeenCalledTimes(1);
});

it('rejects malformed or unbounded event identifiers before writes', async () => {
  for (const sourceEventId of ['', 'x'.repeat(129), 'bad\nkey']) {
    await expect(appendMasonMessage('Hello', { ...opts, sourceEventId })).rejects.toMatchObject({ code: 400 });
  }
  expect(fake.complete).not.toHaveBeenCalled();
});

it('records only once without a model call and preserves scrubbing', async () => {
  const options = { ...opts, recordOnly: true };
  const a = await appendMasonMessage('Hello\u0000 there', options);
  expect(a.outcome).toBe('completed');
  expect(a.message.text).not.toContain('\u0000');
  expect(await appendMasonMessage('Hello\u0000 there', options)).toEqual(a);
  expect(rows()).toHaveLength(1);
  expect(fake.complete).not.toHaveBeenCalled();
});

it('retains pending acceptance across restart after a failed thread append', async () => {
  mkdirSync(leaderRoot(), { recursive: true });
  mkdirSync(leaderThreadPath()); // Real I/O failure after durable acceptance.
  await expect(appendMasonMessage('Hello', opts)).rejects.toThrow();
  rmSync(leaderThreadPath(), { recursive: true });
  install();
  const retry = await appendMasonMessage('Hello', opts);
  expect(retry.outcome).toBe('pending');
  expect(retry.reply).toBeNull();
  expect(fake.complete).not.toHaveBeenCalled();
});

it('does not invoke after failed reservation and can accept a later retry', async () => {
  const original = storage.writePrivateFileAtomic;
  const spy = vi.spyOn(storage, 'writePrivateFileAtomic').mockImplementation(() => { throw new Error('fake write failure'); });
  await expect(appendMasonMessage('Hello', opts)).rejects.toThrow('fake write failure');
  expect(fake.complete).not.toHaveBeenCalled();
  spy.mockImplementation(original);
  expect((await appendMasonMessage('Hello', opts)).outcome).toBe('completed');
});

it('does not falsely complete when the completion receipt write fails', async () => {
  const original = storage.writePrivateFileAtomic;
  vi.spyOn(storage, 'writePrivateFileAtomic').mockImplementation((path, text) => {
    if (path.endsWith('thread-index.json') && text.includes('"outcome":"completed"')) throw new Error('fake completion failure');
    return original(path, text);
  });
  await expect(appendMasonMessage('Hello', opts)).rejects.toThrow('fake completion failure');
  install();
  expect((await appendMasonMessage('Hello', opts)).outcome).toBe('pending');
  expect(fake.complete).toHaveBeenCalledTimes(1);
});

it('fails closed for corrupt receipt storage', async () => {
  await appendMasonMessage('Hello', opts);
  writeFileSync(join(leaderRoot(), 'thread-index.json'), '{');
  await expect(appendMasonMessage('Hello', opts)).rejects.toMatchObject({ code: 409 });
  expect(fake.complete).toHaveBeenCalledTimes(1);
});

it('reuses explicit directive acceptance without recording or composing it twice', async () => {
  const a = await appendMasonMessage('focus: fake fixture work', opts);
  expect(a.directive?.kind).toBe('focus');
  expect(await appendMasonMessage('focus: fake fixture work', opts)).toEqual(a);
  expect(fake.complete).toHaveBeenCalledTimes(1);
});

it('refuses new keys at capacity while continuing to serve existing receipts', async () => {
  const options = { ...opts, recordOnly: true };
  const a = await appendMasonMessage('Hello', options);
  const path = join(leaderRoot(), 'thread-index.json');
  const index = JSON.parse(readFileSync(path, 'utf8'));
  const receipt = Object.values(index.inputs)[0];
  // Populate a full valid index directly; avoid 189 unrelated fsyncs in setup.
  for (let i = 1; i < 64; i++) index.inputs[i.toString(16).padStart(64, '0')] = receipt;
  writeFileSync(path, JSON.stringify(index));
  await expect(appendMasonMessage('Hello', { ...options, sourceEventId: 'overflow' })).rejects.toMatchObject({ code: 409 });
  expect(await appendMasonMessage('Hello', options)).toEqual(a);
  expect(rows()).toHaveLength(1);
});
