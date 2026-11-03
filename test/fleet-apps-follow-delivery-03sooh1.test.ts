import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsFollow } from '../src/cli/fleet-apps-follow.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'follow-delivery-')); roots.push(root);
  const checkpoint = join(root, 'checkpoint');
  return { checkpoint, args: ['--root', root, '--checkpoint', checkpoint, '--duration-ms', '1000', '--jsonl'] };
};
const id = '12345678-1234-4123-8123-123456789abc';
const event = (cursor: number, kind = 'apps-watch.observation.v1') => ({ cursor, kind, invocationId: id, outcome: 'completed' });
const page = (events: Record<string, unknown>[], nextCursor: number) => ({ v: 1 as const, availability: 'available', events, nextCursor, hasMore: false });
const cursor = (path: string) => JSON.parse(readFileSync(path, 'utf8')).cursor;
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('waits for event delivery before writing the checkpoint', async () => {
  const { args, checkpoint } = setup(); let release!: () => void;
  const pendingWrite = new Promise<void>(resolve => { release = resolve; });
  const emit = vi.fn().mockImplementationOnce(() => pendingWrite).mockResolvedValue(undefined);
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(page([event(1)], 1));
  const pending = cmdFleetAppsFollow([...args, '--max-events', '1'], { reader, emit });
  await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
  expect(existsSync(checkpoint)).toBe(false);
  release(); expect(await pending).toBe(0); expect(cursor(checkpoint)).toBe(1);
});

it('does not checkpoint a failed event or later events', async () => {
  const { args, checkpoint } = setup();
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(page([event(1), event(2)], 2));
  const emit = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('closed'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetAppsFollow(args, { reader, emit })).toBe(1);
  expect(existsSync(checkpoint)).toBe(false); expect(emit).toHaveBeenCalledTimes(2);
});

it('resumes after a delivered multi-event page', async () => {
  const { args, checkpoint } = setup();
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValueOnce(page([event(1), event(2)], 3)).mockReturnValueOnce(page([event(4)], 4));
  const emit = vi.fn().mockResolvedValue(undefined);
  expect(await cmdFleetAppsFollow([...args, '--max-events', '2'], { reader, emit })).toBe(0);
  expect(cursor(checkpoint)).toBe(3);
  expect(await cmdFleetAppsFollow([...args, '--max-events', '1'], { reader, emit })).toBe(0);
  expect(reader.mock.calls.map(call => call[1])).toEqual([0, 3]); expect(cursor(checkpoint)).toBe(4);
});

it('stops and checkpoints at the delivered invocation summary', async () => {
  const { args, checkpoint } = setup();
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(page([event(1), event(2, 'apps-watch.summary.v1'), event(3)], 3));
  const lines: string[] = [];
  expect(await cmdFleetAppsFollow([...args, '--invocation-id', id, '--until-summary'], { reader, emit: line => { lines.push(line); } })).toBe(0);
  expect(cursor(checkpoint)).toBe(2); expect(lines.map(line => JSON.parse(line).type)).toEqual(['event', 'event', 'summary']);
  expect(JSON.parse(lines[2]!)).toMatchObject({ reason: 'invocation_finished', nextCursor: 2 });
});

it.each(['deadline', 'cancellation'] as const)('bounds a stalled event by %s without later checkpoint mutation', async mode => {
  const { args, checkpoint } = setup(); let release!: () => void;
  const emit = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(page([event(1)], 1));
  const controller = new AbortController(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const flags = mode === 'deadline' ? args.map(value => value === '1000' ? '20' : value) : args;
  const pending = cmdFleetAppsFollow(flags, { reader, emit, signal: controller.signal });
  await vi.waitFor(() => expect(emit).toHaveBeenCalled());
  if (mode === 'cancellation') controller.abort();
  expect(await pending).toBe(1); expect(existsSync(checkpoint)).toBe(false);
  release(); await Promise.resolve(); expect(existsSync(checkpoint)).toBe(false);
});

it('returns failure when the final summary cannot be delivered', async () => {
  const { args, checkpoint } = setup();
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(page([event(1)], 1));
  const emit = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('closed'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetAppsFollow([...args, '--max-events', '1'], { reader, emit })).toBe(1);
  expect(cursor(checkpoint)).toBe(1);
});
