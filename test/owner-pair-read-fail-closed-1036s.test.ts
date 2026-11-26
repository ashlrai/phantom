import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PAIR_TTL_MS, pairTick, readPairState, startOwnerPair, type PairDeps } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pair-read-'));
  roots.push(dir);
  const file = join(dir, 'comms', 'owner-pair.json');
  mkdirSync(join(dir, 'comms'));
  const bridge = {
    ownHandles: vi.fn(async () => ['fake-handle']),
    baseline: vi.fn(async () => 42),
    send: vi.fn(async () => true),
    replies: vi.fn(async () => []),
  };
  const deps: PairDeps = { configDir: dir, bridge, now: () => 100_000 };
  return { file, bridge, deps };
}

it.each(['{ broken', 'null', '[]', '42', '"state"'])('refuses malformed or invalid state %s without replacing it', async raw => {
  const s = setup();
  writeFileSync(s.file, raw);
  expect(await startOwnerPair(s.deps)).toEqual({ status: 'state-unreadable' });
  expect(await pairTick(s.deps)).toEqual({ action: 'none', detail: 'state-unreadable' });
  expect(s.bridge.send).not.toHaveBeenCalled();
  expect(s.bridge.ownHandles).not.toHaveBeenCalled();
  expect(readFileSync(s.file, 'utf8')).toBe(raw);
});

it('refuses an unreadable state path without replacing the directory', async () => {
  const s = setup();
  mkdirSync(s.file);
  expect(await startOwnerPair(s.deps)).toEqual({ status: 'state-unreadable' });
  expect(await pairTick(s.deps)).toEqual({ action: 'none', detail: 'state-unreadable' });
  expect(s.bridge.send).not.toHaveBeenCalled();
  expect(statSync(s.file).isDirectory()).toBe(true);
});

it('allows first run when the file is missing', async () => {
  const s = setup();
  expect((await pairTick(s.deps)).action).toBe('started');
  expect(s.bridge.send).toHaveBeenCalledTimes(1);
  expect(readPairState(s.deps.configDir).pending?.afterRowId).toBe(42);
});

it.each([{ autoOff: true, lastStartAt: null }, { autoOff: false, lastStartAt: 100_000 - PAIR_TTL_MS + 1 }])('preserves opt-out and cooldown', async state => {
  const s = setup();
  writeFileSync(s.file, JSON.stringify({ pending: null, ...state }));
  expect(await pairTick(s.deps)).toEqual({ action: 'none', detail: 'too-soon' });
  expect(s.bridge.send).not.toHaveBeenCalled();
});

it('reads a legacy single handle and its pending cursor', async () => {
  const s = setup();
  writeFileSync(s.file, JSON.stringify({ pending: { handle: 'fake-handle', startedAt: 1, expiresAt: 200_000, afterRowId: 17 }, lastStartAt: 1 }));
  expect(readPairState(s.deps.configDir).pending).toEqual({ handles: ['fake-handle'], startedAt: 1, expiresAt: 200_000, afterRowId: 17 });
  expect((await pairTick(s.deps)).action).toBe('waiting');
  expect(s.bridge.replies).toHaveBeenCalledWith(17, ['fake-handle']);
  expect(s.bridge.send).not.toHaveBeenCalled();
});
