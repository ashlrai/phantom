import { getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetEmailOutboxAwait } from '../src/cli/fleet-email-outbox-await.js';

const name = 'artifact.reply.eml';
const reply = 'To: fake@example.test\nSubject: test\n\nbody';
const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'single-await-'));
  dirs.push(dir);
  return dir;
}
function args(dir?: string): string[] {
  return ['--name', name, '--timeout-ms', '300', '--poll-ms', '100', ...(dir ? ['--dir', dir] : []), '--json'];
}
function listeners(signal: AbortSignal): number[] {
  return [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), getEventListeners(signal, 'abort').length];
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('refuses ambiguous queued and sent artifacts', async () => {
  const dir = fixture();
  mkdirSync(join(dir, 'sent'));
  writeFileSync(join(dir, name), reply);
  writeFileSync(join(dir, 'sent', name), reply);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetEmailOutboxAwait(args(dir))).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, state: 'stuck', reason: 'malformed', timedOut: false, cancelled: false });
});

it('clears queued evidence when the real source disappears between polls', async () => {
  const dir = fixture();
  writeFileSync(join(dir, name), reply);
  const controller = new AbortController();
  const before = listeners(controller.signal);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let now = 0;
  let sleeps = 0;
  expect(await cmdFleetEmailOutboxAwait(args(dir), { signal: controller.signal, now: () => now, sleep: async (ms) => {
    now += ms; sleeps++; rmSync(dir, { recursive: true });
  } })).toBe(1);
  expect(sleeps).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, reason: 'source-failure', timedOut: false, cancelled: false });
  expect(listeners(controller.signal)).toEqual(before);
});

it('resolves the configured outbox from a scratch runs directory and restores listeners on success', async () => {
  const root = fixture();
  const runsDir = join(root, 'runs');
  const outbox = join(root, 'outbox');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  mkdirSync(join(outbox, 'drafted'), { recursive: true });
  writeFileSync(join(runsDir, 'queue', 'email-drop.json'), JSON.stringify({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] }));
  writeFileSync(join(outbox, name), reply);
  const controller = new AbortController();
  const before = listeners(controller.signal);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let now = 0;
  expect(await cmdFleetEmailOutboxAwait(args(), { runsDir, signal: controller.signal, now: () => now, sleep: async (ms) => {
    now += ms; renameSync(join(outbox, name), join(outbox, 'drafted', name));
  } })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, state: 'drafted', timedOut: false, cancelled: false });
  expect(listeners(controller.signal)).toEqual(before);
});

it('returns 130 for an already aborted signal before reading or resolving config', async () => {
  const dir = fixture();
  const controller = new AbortController();
  controller.abort();
  const before = listeners(controller.signal);
  const read = vi.fn();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetEmailOutboxAwait(args(), { runsDir: join(dir, 'missing'), read, signal: controller.signal })).toBe(130);
  expect(read).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, cancelled: true, timedOut: false });
  expect(listeners(controller.signal)).toEqual(before);
});
