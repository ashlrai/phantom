import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureOwnerAdaptersFile } from '../src/core/comms/owner-adapters-file.js';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { checkOwnerPair, startOwnerPair, type PairBridge, type PairDeps } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function setup(results: ('reject' | boolean)[]) {
  const dir = mkdtempSync(join(tmpdir(), 'pair-partial-'));
  roots.push(dir);
  ensureOwnerAdaptersFile(dir);
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = true\n');
  const send = vi.fn(async () => {
    const result = results.shift();
    if (result === 'reject') throw new Error('synthetic failure');
    return result === true;
  });
  const bridge: PairBridge = {
    ownHandles: async () => ['fake-a', 'fake-b'],
    baseline: async () => 10,
    send,
    replies: async () => [{ rowid: 11, handle: 'fake-a', text: 'YES' }],
  };
  const deps: PairDeps = { configDir: dir, bridge, now: () => 1000 };
  const stateFile = join(dir, 'comms', 'owner-pair.json');
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  return { dir, deps, send, stateFile, state };
}

it('retains the first delivery after a later rejection and accepts its YES', async () => {
  const s = setup([true, 'reject']);
  expect(await startOwnerPair(s.deps)).toMatchObject({ status: 'pending', handles: ['fake-a'] });
  expect(s.state().pending.handles).toEqual(['fake-a']);
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
  expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBe('fake-a');
  expect(s.state().pending).toBeNull();
});

it('continues after a rejection and records only the second delivery', async () => {
  const s = setup(['reject', true]);
  expect(await startOwnerPair(s.deps)).toMatchObject({ status: 'pending', handles: ['fake-b'] });
  expect(s.state().pending.handles).toEqual(['fake-b']);
  expect(s.send).toHaveBeenCalledTimes(2);
});

it.each([['reject', false], [false, 'reject'], ['reject', 'reject']] as const)(
  'leaves no pending state when deliveries fail (%s, %s)', async (first, second) => {
    const s = setup([first, second]);
    expect(await startOwnerPair(s.deps)).toEqual({ status: 'send-failed' });
    expect(existsSync(s.stateFile)).toBe(false);
    expect(s.send).toHaveBeenCalledTimes(2);
  },
);

it('does not resend a partially delivered automatic invitation in its live window', async () => {
  const s = setup([true, 'reject']);
  expect(await startOwnerPair(s.deps, { auto: true })).toMatchObject({ status: 'pending', handles: ['fake-a'] });
  const saved = s.state();
  expect(saved.pending.handles).toEqual(['fake-a']);
  expect(await startOwnerPair(s.deps, { auto: true })).toEqual({ status: 'already-pending' });
  expect(s.send).toHaveBeenCalledTimes(2);
  expect(s.state()).toEqual(saved);
});
