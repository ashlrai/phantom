import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkOwnerPair, PAIR_TTL_MS, readPairState, startOwnerPair, unpairOwner, type PairDeps } from '../src/core/comms/owner-pair.js';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/comms-confirm-route.js', () => ({ confirmCommsForOwnerProof: confirm }));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => confirm.mockReset());

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pair-retry-')); dirs.push(dir);
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = false\n');
  let now = 100000;
  const send = vi.fn(async () => true);
  const replies = vi.fn(async () => [{ rowid: 11, text: 'YES', handle: 'owner-test' }]);
  const deps: PairDeps = { configDir: dir, now: () => now, bridge: {
    ownHandles: async () => ['owner-test'], baseline: async () => 10, send, replies,
  } };
  const network = (handle: string) => writeFileSync(join(dir, 'agent-network.toml'), `[mason]\nidentities = [{ channel = "imessage", id = "${handle}" }]\n[team]\nidentities = [{ channel = "imessage", id = "${handle}" }]\n`);
  return { dir, deps, send, replies, network, advance: (ms: number) => { now += ms; } };
}

async function failed(s: ReturnType<typeof setup>) {
  confirm.mockReturnValueOnce({ ok: false, reason: 'temporary' });
  expect((await startOwnerPair(s.deps)).status).toBe('pending');
  expect(await checkOwnerPair(s.deps)).toMatchObject({ status: 'bound', confirmed: false });
}

it('retries the persisted YES once without another invitation or Messages read', async () => {
  const s = setup(); await failed(s);
  expect(readPairState(s.dir).pending).not.toBeNull();
  confirm.mockReturnValueOnce({ ok: true });
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'none' });
  expect((await startOwnerPair(s.deps)).status).toBe('already-paired');
  expect(s.send).toHaveBeenCalledTimes(1); expect(s.replies).toHaveBeenCalledTimes(1); expect(confirm).toHaveBeenCalledTimes(2);
});

it('retains evidence when confirmation throws', async () => {
  const s = setup(); confirm.mockImplementationOnce(() => { throw new Error('temporary'); });
  await startOwnerPair(s.deps);
  expect(await checkOwnerPair(s.deps)).toMatchObject({ status: 'bound', confirmed: false });
  confirm.mockReturnValueOnce({ ok: true });
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
});

it.each(['expired', 'unpaired', 'replacement', 'different owner'] as const)('rejects %s proof', async condition => {
  const s = setup(); await failed(s); confirm.mockClear();
  if (condition === 'expired') s.advance(PAIR_TTL_MS);
  if (condition === 'unpaired') unpairOwner(s.dir);
  if (condition === 'replacement') {
    const file = join(s.dir, 'comms', 'owner-pair.json');
    const state = JSON.parse(readFileSync(file, 'utf8')); state.pending.startedAt++;
    writeFileSync(file, JSON.stringify(state));
  }
  if (condition === 'different owner') s.network('other-test');
  s.replies.mockResolvedValue([]);
  await checkOwnerPair(s.deps);
  expect(confirm).not.toHaveBeenCalled();
});

it('does not invoke confirmation for an already confirmed owner', async () => {
  const s = setup(); writeFileSync(join(s.dir, 'comms.toml'), 'confirmedByMason = true\n');
  await startOwnerPair(s.deps);
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
  expect(confirm).not.toHaveBeenCalled();
  expect((await startOwnerPair(s.deps)).status).toBe('already-paired');
});
