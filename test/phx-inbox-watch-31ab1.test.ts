import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { appendInboxEntry } from '../src/core/fleet/mason-inbox.js';

const roots: string[] = [];
function setup(wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'inbox-watch-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const signals = new EventEmitter();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const command = createCommsInboxCommand({ runsDir, signals, wait });
  const snapshots = () => log.mock.calls.map(call => JSON.parse(String(call[0])));
  return { root, runsDir, signals, log, command, snapshots };
}
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('emits sequential full filtered snapshots including a newly appended instruction', async () => {
  let runsDir = '';
  const wait = vi.fn(async (ms: number) => {
    expect(ms).toBe(2000);
    expect(await appendInboxEntry('second instruction', { runsDir, source: 'Mobile', now: () => new Date('2026-10-31T04:15:00Z') })).toMatchObject({ ok: true });
  });
  const ctx = setup(wait); runsDir = ctx.runsDir;
  await appendInboxEntry('first instruction', { runsDir, source: 'Mobile', now: () => new Date('2026-10-31T04:14:00Z') });
  await appendInboxEntry('other source', { runsDir, source: 'Desktop', now: () => new Date('2026-10-31T04:14:00Z') });
  const args = ['read', '--watch', '--interval-ms', '2000', '--max-samples', '2', '--source', 'mobile', '--priority', 'P0', '--after', '2026-10-31T04:13:00Z', '--limit', '2'];
  expect(await ctx.command(args)).toBe(0);
  expect(wait).toHaveBeenCalledTimes(1);
  expect(ctx.snapshots()).toEqual([
    { sourceState: 'healthy', omittedUndated: 0, entries: [expect.objectContaining({ text: 'first instruction' })] },
    { sourceState: 'healthy', omittedUndated: 0, entries: [expect.objectContaining({ text: 'first instruction' }), expect.objectContaining({ text: 'second instruction' })] },
  ]);
  expect(ctx.signals.listenerCount('SIGINT')).toBe(0);
  expect(ctx.signals.listenerCount('SIGTERM')).toBe(0);
});

it('treats missing as a snapshot and retains one-shot output', async () => {
  const wait = vi.fn(async (_ms: number) => {});
  const { command, snapshots } = setup(wait);
  expect(await command(['read'])).toBe(0);
  expect(await command(['read', '--watch', '--max-samples', '2'])).toBe(0);
  expect(snapshots()).toEqual(Array(3).fill({ sourceState: 'missing', entries: [] }));
  expect(wait).toHaveBeenCalledOnce();
  expect(wait.mock.calls[0]?.[0]).toBe(1000);
});

it.each(['SIGINT', 'SIGTERM'] as const)('stops on %s while waiting and removes only its own handlers', async signalName => {
  const existing = vi.fn();
  const wait = vi.fn(async (_ms: number, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    signals.emit(signalName);
    expect(signal.aborted).toBe(true);
  });
  const ctx = setup(wait);
  const signals = ctx.signals;
  signals.on(signalName, existing);
  expect(await ctx.command(['read', '--watch'])).toBe(0);
  expect(ctx.snapshots()).toEqual([{ sourceState: 'missing', entries: [] }]);
  expect(existing).toHaveBeenCalledOnce();
  expect(signals.listenerCount(signalName)).toBe(1);
  expect(signals.listenerCount(signalName === 'SIGINT' ? 'SIGTERM' : 'SIGINT')).toBe(0);
});

it('does not emit a snapshot if cancelled during the read', async () => {
  const { command, signals, snapshots } = setup();
  const pending = command(['read', '--watch']);
  signals.emit('SIGINT');
  expect(await pending).toBe(0);
  expect(snapshots()).toEqual([]);
  expect(signals.listenerCount('SIGINT')).toBe(0);
  expect(signals.listenerCount('SIGTERM')).toBe(0);
});

it('emits a degraded snapshot and exits without retrying a failed read', async () => {
  let root = '';
  const wait = vi.fn(async () => {
    rmSync(join(root, 'runs', 'leader'), { recursive: true });
    writeFileSync(join(root, 'runs', 'leader'), 'not a directory');
  });
  const ctx = setup(wait); root = ctx.root;
  mkdirSync(join(ctx.runsDir, 'leader'), { recursive: true });
  expect(await ctx.command(['read', '--watch'])).toBe(1);
  expect(ctx.snapshots()).toEqual([{ sourceState: 'missing', entries: [] }, { sourceState: 'degraded', entries: [] }]);
  expect(wait).toHaveBeenCalledOnce();
  expect(ctx.signals.listenerCount('SIGINT')).toBe(0);
  expect(ctx.signals.listenerCount('SIGTERM')).toBe(0);
});

it('validates watch options before reading and supports their boundary values', async () => {
  const { command, snapshots } = setup();
  for (const args of [
    ['read', '--interval-ms', '1000'], ['read', '--max-samples', '1'],
    ['read', '--watch', '--watch'], ['read', '--watch', '--interval-ms'],
    ['read', '--watch', '--interval-ms', '999'], ['read', '--watch', '--interval-ms', '60001'],
    ['read', '--watch', '--interval-ms', '1e3'], ['read', '--watch', '--max-samples', '0'],
    ['read', '--watch', '--max-samples', '10001'], ['read', '--watch', '--max-samples', '1.0'],
    ['read', '--watch', '--max-samples', '1', '--max-samples', '2'],
    ['read', '--source', '--watch'], ['post', '--file', '-', '--watch'],
  ]) {
    expect(await command(args)).toBe(2);
    expect(snapshots().at(-1)).toEqual({ status: 'invalid' });
  }
  expect(await command(['read', '--interval-ms', '60000', '--max-samples', '1', '--watch'])).toBe(0);
  expect(snapshots().at(-1)).toEqual({ sourceState: 'missing', entries: [] });
  const stop = setup(async (_ms, signal) => { expect(signal.aborted).toBe(false); throw new Error('wait failed'); });
  await expect(stop.command(['read', '--watch', '--interval-ms', '1000', '--max-samples', '10000'])).rejects.toThrow('wait failed');
  expect(stop.signals.listenerCount('SIGINT')).toBe(0);
  expect(stop.signals.listenerCount('SIGTERM')).toBe(0);
});
