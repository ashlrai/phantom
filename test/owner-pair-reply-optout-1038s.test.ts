import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkOwnerPair, readPairState, startOwnerPair, unpairOwner, type PairDeps, type PairInbound } from '../src/core/comms/owner-pair.js';

const confirm = vi.hoisted(() => vi.fn(() => ({ ok: true })));
vi.mock('../src/core/web/comms-confirm-route.js', () => ({ confirmCommsForOwnerProof: confirm }));
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); confirm.mockClear(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pair-reply-'));
  roots.push(dir);
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = false\n');
  let resolve!: (rows: PairInbound[] | null) => void;
  const replies = new Promise<PairInbound[] | null>(r => { resolve = r; });
  let now = 1000;
  const deps: PairDeps = { configDir: dir, now: () => now, bridge: {
    ownHandles: async () => ['fake-owner'], baseline: async () => 10,
    send: async () => true, replies: async () => replies,
  } };
  return { dir, deps, resolve, advance: () => { now++; } };
}

it.each(['YES', 'NO'])('keeps unpair effective when an old poll returns %s', async text => {
  const s = setup();
  await startOwnerPair(s.deps);
  const poll = checkOwnerPair(s.deps);
  expect(unpairOwner(s.dir).status).toBe('unpaired');
  s.resolve([{ rowid: 11, handle: 'fake-owner', text }]);
  expect(await poll).toEqual({ status: 'none' });
  expect(readPairState(s.dir)).toMatchObject({ pending: null, autoOff: true });
  expect(existsSync(join(s.dir, 'agent-network.toml'))).toBe(false);
  expect(readFileSync(join(s.dir, 'comms.toml'), 'utf8')).toBe('confirmedByMason = false\n');
  expect(confirm).not.toHaveBeenCalled();
});

it('leaves a replacement invitation untouched by the old reply', async () => {
  const s = setup();
  await startOwnerPair(s.deps);
  const poll = checkOwnerPair(s.deps);
  unpairOwner(s.dir);
  s.advance();
  await startOwnerPair(s.deps, { handle: 'new-owner' });
  const replacement = readPairState(s.dir);
  s.resolve([{ rowid: 11, handle: 'fake-owner', text: 'YES' }]);
  expect(await poll).toEqual({ status: 'waiting' });
  expect(readPairState(s.dir)).toEqual(replacement);
  expect(existsSync(join(s.dir, 'agent-network.toml'))).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
});

it('binds a valid YES for an unchanged invitation', async () => {
  const s = setup();
  await startOwnerPair(s.deps);
  const poll = checkOwnerPair(s.deps);
  s.resolve([{ rowid: 11, handle: 'fake-owner', text: 'YES' }]);
  expect(await poll).toEqual({ status: 'bound', confirmed: true });
  expect(readFileSync(join(s.dir, 'agent-network.toml'), 'utf8')).toContain('fake-owner');
  expect(confirm).toHaveBeenCalledOnce();
});
