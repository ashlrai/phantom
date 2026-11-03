import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsFollow } from '../src/cli/fleet-apps-follow.js';
import { readFollowCheckpoint, normalizeRoot, writeFollowCheckpointWithRoot, writeFollowCheckpoint } from '../src/core/fleet/apps-follow-checkpoint.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';

const dirs: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'follow-root-checkpoint-')); dirs.push(path); return path; };
const id = '12345678-1234-4123-8123-123456789abc';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const args = (path: string) => ['--duration-ms', '100', '--jsonl', '--checkpoint', path];
const page = (events: Record<string, unknown>[], nextCursor: number) => ({ v: 1 as const, availability: 'available', events, nextCursor, hasMore: false });
const event = (cursor: number, kind = 'apps-watch.observation.v1') => ({ cursor, kind, invocationId: id, outcome: 'completed' });
const emptyPage = () => ({ v: 1 as const, availability: 'available', events: [] as Record<string, unknown>[], nextCursor: 0, hasMore: false });
const record = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const root = () => join(dir(), 'root' + dirs.length);
afterEach(() => { vi.restoreAllMocks(); for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

// Verify writeFollowCheckpointWithRoot correctly writes version 2 with root
it('correctly writes version 2 checkpoint with root', async () => {
  const path = join(dir(), 'cursor.json'), rootPath = root();
  writeFollowCheckpointWithRoot(path, 42, id, rootPath);
  const cp = record(path);
  expect(cp.version).toBe(2);
  expect(cp.cursor).toBe(42);
  expect(normalizeRoot(cp.root)).toBe(normalizeRoot(rootPath));
  expect(cp.invocationId).toBe(id);
});

// Root scoping works for CLI --root
it('creates a root-scoped checkpoint and resumes from it', async () => {
  const path = join(dir(), 'cursor.json'), reader = vi.fn<typeof readAppsRecoveryHistory>(), rootPath = root();
  reader.mockReturnValueOnce(page([event(1)], 1)).mockReturnValueOnce(page([event(2)], 2));
  let time = 0;
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootPath], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  const cp = record(path);
  expect(cp.version).toBe(2);
  expect(cp.cursor).toBe(1);
  expect(normalizeRoot(cp.root)).toBe(normalizeRoot(rootPath));
  // Resume: reads v2 checkpoint, validates root
  reader.mockClear();
  reader.mockReturnValueOnce(page([event(3)], 3));
  time = 0;
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootPath], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  expect(record(path).cursor).toBe(2);
  expect(record(path).version).toBe(2);
});

// Root mismatch blocks reader
it('rejects a mismatched source: exit 2, zero reader calls, unchanged checkpoint', async () => {
  const path = join(dir(), 'cursor.json'), reader = vi.fn<typeof readAppsRecoveryHistory>(), rootA = root(), rootB = join(dir(), 'alt-root');
  reader.mockReturnValueOnce(page([event(1)], 1));
  let time = 0;
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootA], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  const before = JSON.stringify(record(path));
  expect(record(path).version).toBe(2);
  expect(normalizeRoot(record(path).root)).toBe(normalizeRoot(rootA));
  // root B with same checkpoint -> rejects
  reader.mockClear();
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootB], { reader })).toBe(2);
  expect(reader).not.toHaveBeenCalled();
  expect(JSON.stringify(record(path))).toBe(before);
  // root A resumes
  reader.mockReturnValueOnce(page([event(4)], 4));
  time = 0;
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootA], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
});

// Equivalent paths resolve to the same root
it('equivalent path spellings resume from the same checkpoint', async () => {
  const path = join(dir(), 'cursor.json'), reader = vi.fn<typeof readAppsRecoveryHistory>(), base = root();
  const rootA = join(base, 'subdir', 'rootA');
  const equiv = join(base, 'subdir', '.', 'rootA');
  expect(normalizeRoot(rootA)).toBe(normalizeRoot(equiv));
  reader.mockReturnValueOnce(page([event(1)], 1));
  let time = 0;
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootA], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  expect(normalizeRoot(record(path).root)).toBe(normalizeRoot(equiv));
  // Resume with equivalent spelling
  reader.mockClear();
  reader.mockReturnValueOnce(page([event(2)], 2));
  time = 0;
  expect(await cmdFleetAppsFollow([...args(path), '--root', equiv], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
});

// Mismatched invocationId is rejected (generic message, no path leak)
it('mismatched invocationId is rejected (generic message, no path leak)', async () => {
  const path = join(dir(), 'cursor.json'), rootPath = root();
  writeFollowCheckpointWithRoot(path, 5, id, rootPath);
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootPath, '--invocation-id', otherId], { reader: vi.fn() })).toBe(2);
});

// Root mismatch with matching invocationId is rejected (migration message, no path leak)
it('root mismatch on a matching invocationId is rejected (migration message, no path leak)', async () => {
  const path = join(dir(), 'cursor.json'), rootA = root(), rootB = join(dir(), 'other-root');
  writeFollowCheckpointWithRoot(path, 5, id, rootA);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootB, '--invocation-id', id], { reader: vi.fn(), error })).toBe(2);
  const msg = error.mock.calls[0]![0] as string;
  expect(msg).toContain('root');
  expect(msg).not.toContain(rootA);
  expect(msg).not.toContain(rootB);
  expect(msg).not.toContain(normalizeRoot(rootA));
  expect(msg).not.toContain(normalizeRoot(rootB));
});

// Missing checkpoint starts at zero
it('missing checkpoint still starts at zero', async () => {
  const cpDir = join(dir(), 'cp'), rootPath = root();
  mkdirSync(cpDir, { recursive: true });
  const cpPath = join(cpDir, 'cursor.json');
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(emptyPage());
  let time = 0;
  expect(await cmdFleetAppsFollow([...args(cpPath), '--root', rootPath], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  const cp = record(cpPath);
  expect(cp.version).toBe(2);
  expect(cp.root).toBeDefined();
});

// Legacy v1 unscoped checkpoint triggers migration
it('legacy unscoped v1 checkpoint is rejected with migration guidance', async () => {
  const path = join(dir(), 'cursor.json'), rootPath = root();
  writeFollowCheckpoint(path, 50, undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootPath], { reader: vi.fn(), error })).toBe(2);
  const msg = error.mock.calls[0]![0] as string;
  expect(msg).toContain('migration');
  expect(msg).not.toContain(rootPath);
  expect(msg).not.toContain(normalizeRoot(rootPath));
});

// Failed delivery does not advance persisted cursor
it('failed event delivery does not advance the persisted cursor', async () => {
  const path = join(dir(), 'cursor.json'), rootPath = root();
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(emptyPage());
  expect(await cmdFleetAppsFollow([...args(path), '--root', rootPath], { reader })).toBe(0);
  const cp = record(path);
  expect(cp.version).toBe(2);
  expect(cp.cursor).toBe(0);
  expect(cp.root).toBe(normalizeRoot(rootPath));
});

// Different invocations are scoped to their own checkpoints
it('different invocations are scoped to their own checkpoints', async () => {
  const pathA = join(dir(), 'a.json'), pathB = join(dir(), 'b.json'), rootPath = root();
  const reader = vi.fn<typeof readAppsRecoveryHistory>().mockReturnValue(page([event(1)], 1));
  let time = 0;
  expect(await cmdFleetAppsFollow([...args(pathA), '--root', rootPath, '--invocation-id', id], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  expect(record(pathA).invocationId).toBe(id);
  reader.mockClear();
  reader.mockReturnValueOnce(page([event(3)], 3));
  time = 0;
  expect(await cmdFleetAppsFollow([...args(pathB), '--root', rootPath, '--invocation-id', otherId], { reader, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  expect(record(pathB).invocationId).toBe(otherId);
  // Mismatched invocationId fails
  expect(await cmdFleetAppsFollow([...args(pathA), '--root', rootPath, '--invocation-id', otherId], { reader: vi.fn() })).toBe(2);
  expect(readFileSync(pathA, 'utf8')).toBe(JSON.stringify(record(pathA)) + '\n');
  expect(record(pathA).invocationId).toBe(id);
  expect(record(pathA).root).toBe(normalizeRoot(rootPath));
});
