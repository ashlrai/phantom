import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { PAIR_TTL_MS, checkOwnerPair, readPairState, startOwnerPair, unpairOwner, type PairBridge, type PairInbound } from '../src/core/comms/owner-pair.js';

vi.setConfig({ testTimeout: 30_000 });
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pair-expiry-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = false\n');
  let now = Date.UTC(2026, 10, 21);
  let resolve!: (rows: PairInbound[] | null) => void;
  const bridge: PairBridge = {
    async ownHandles() { return ['fake-owner']; },
    async baseline() { return 10; },
    async send() { return true; },
    replies() { return new Promise(r => { resolve = r; }); },
  };
  const deps = { configDir: dir, bridge, now: () => now };
  await startOwnerPair(deps);
  const check = checkOwnerPair(deps);
  return { dir, deps, check, advance: (ms: number) => { now += ms; }, reply: () => resolve([{ rowid: 11, handle: 'fake-owner', text: 'YES' }]) };
}

it.each([PAIR_TTL_MS, PAIR_TTL_MS + 1])('expires a deferred YES at offset %i', async offset => {
  const s = await setup();
  s.advance(offset);
  s.reply();
  expect(await s.check).toEqual({ status: 'expired' });
  expect(readPairState(s.dir).pending).toBeNull();
  expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBeUndefined();
  expect(readFileSync(join(s.dir, 'comms.toml'), 'utf8')).toBe('confirmedByMason = false\n');
});

it('binds a YES just before expiry', async () => {
  const s = await setup();
  s.advance(PAIR_TTL_MS - 1);
  s.reply();
  expect(await s.check).toMatchObject({ status: 'bound' });
  expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBe('fake-owner');
});

it('preserves a replacement invitation when the original expires during I/O', async () => {
  const s = await setup();
  s.advance(PAIR_TTL_MS);
  await startOwnerPair(s.deps, { handle: 'replacement' });
  const replacement = readPairState(s.dir);
  s.reply();
  expect(await s.check).toEqual({ status: 'expired' });
  expect(readPairState(s.dir)).toEqual(replacement);
  expect(existsSync(join(s.dir, 'agent-network.toml'))).toBe(false);
});

it('preserves an unpair while the original expires during I/O', async () => {
  const s = await setup();
  unpairOwner(s.dir);
  const state = readPairState(s.dir);
  s.advance(PAIR_TTL_MS);
  s.reply();
  expect(await s.check).toEqual({ status: 'expired' });
  expect(readPairState(s.dir)).toEqual(state);
});
