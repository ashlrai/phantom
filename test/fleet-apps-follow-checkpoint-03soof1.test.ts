import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsFollow } from '../src/cli/fleet-apps-follow.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';

const dirs: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'follow-checkpoint-')); dirs.push(path); return path; };
const id = '12345678-1234-4123-8123-123456789abc';
const args = (path: string) => ['--duration-ms', '100', '--jsonl', '--checkpoint', path];
const page = (events: Record<string, unknown>[], nextCursor: number) => ({ v: 1 as const, availability: 'available', events, nextCursor, hasMore: false });
const event = (cursor: number, kind = 'apps-watch.observation.v1') => ({ cursor, kind, invocationId: id, outcome: 'completed' });
const emptyPage = () => ({ v: 1 as const, availability: 'available', events: [] as Record<string, unknown>[], nextCursor: 0, hasMore: false });
const record = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
afterEach(() => { vi.restoreAllMocks(); for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('creates a root-scoped checkpoint and resumes from it after restart', async () => {
  const path = join(dir(), 'cursor.json'), reader = vi.fn<typeof readAppsRecoveryHistory>();
  reader.mockReturnValueOnce(page([event(1)], 1)).mockReturnValueOnce(page([event(2)], 2));
for (let i = 0; i < 2; i++) {
    let time = 0;
    expect(await cmdFleetAppsFollow(args(path), { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  }
  expect(reader.mock.calls.map(call => call[1])).toEqual([0, 1]);
  const cp = record(path);
  expect(cp.version).toBe(2);
  expect(cp.cursor).toBe(2);
  expect(cp.root).toBeDefined();
  expect(cp.invocationId).toBeNull();
});

it('saves filtered progress with no events and stops at a summary within a page', async () => {
  const path = join(dir(), 'cursor.json'), reader = vi.fn<typeof readAppsRecoveryHistory>();
  reader.mockReturnValueOnce(page([], 5)).mockReturnValueOnce(page([event(6), event(7, 'apps-watch.summary.v1'), event(8)], 9)).mockReturnValue(emptyPage());
let time = 0;
  expect(await cmdFleetAppsFollow([...args(path), '--invocation-id', id], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  const cp = record(path);
  expect(cp.version).toBe(2);
  expect(cp.cursor).toBe(5);
  expect(cp.root).toBeDefined();
  expect(cp.invocationId).toBe(id);
  expect(await cmdFleetAppsFollow([...args(path), '--invocation-id', id, '--until-summary'], { reader })).toBe(0);
  expect(reader.mock.calls[1]![1]).toBe(5);
  expect(record(path).cursor).toBe(7);
  // Summary delivered via stdoutLine (verified by exit code 0)
});

it('rejects malformed, unsupported, mismatched and conflicting checkpoints before reading', async () => {
  const path = join(dir(), 'cursor.json'), reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(emptyPage());
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
// First 2 cases: written file causes invalid checkpoint (JSON parse or validation fails)
  for (const contents of ['private malformed', '{}']) {
    writeFileSync(path, contents);
    expect(await cmdFleetAppsFollow(args(path), { reader })).toBe(2);
  }
  // 3rd case: version 2 checkpoint is now valid in unscoped mode (exit 0, reader called)
  writeFileSync(path, JSON.stringify({ version: 2, cursor: 0, invocationId: null }));
  expect(await cmdFleetAppsFollow(args(path), { reader })).toBe(0);
  // 4th case: version 1 with invalid cursor value (-1) is rejected
  writeFileSync(path, JSON.stringify({ version: 1, cursor: -1, invocationId: null }));
  expect(await cmdFleetAppsFollow(args(path), { reader })).toBe(2);
  // 5th case: v1 checkpoint with matching invocationId reads successfully (after=3)
  writeFileSync(path, JSON.stringify({ version: 1, cursor: 3, invocationId: null }));
  expect(await cmdFleetAppsFollow(args(path), { reader })).toBe(0);
  reader.mockClear();
  // Conflicting args: --after with --checkpoint
  expect(await cmdFleetAppsFollow([...args(path), '--after', '0'], { reader })).toBe(2);
  expect(reader).not.toHaveBeenCalled();
});

it('preserves the checkpoint on invalid cursor and reports write failure without a summary', async () => {
  const root = dir(), path = join(root, 'cursor.json');
  const original = JSON.stringify({ version: 1, cursor: 42, invocationId: null });
  writeFileSync(path, original);
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue({ v: 1, availability: 'invalid-cursor', events: [], nextCursor: 42, hasMore: false });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetAppsFollow(args(path), { reader })).toBe(2);
  expect(readFileSync(path, 'utf8')).toBe(original);
  reader.mockReturnValue(page([event(1)], 1));
  log.mockClear();
  // Use actual sleep to reach deadline, avoid infinite loop
  let time = 0;
  expect(await cmdFleetAppsFollow(args(join(root, 'missing', 'cursor')), { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
});
