import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkOwnerPair, startOwnerPair, type PairBridge, type PairInbound } from '../src/core/comms/owner-pair.js';
import { ensureOwnerAdaptersFile } from '../src/core/comms/owner-adapters-file.js';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pair-superseded-'));
  roots.push(dir);
  ensureOwnerAdaptersFile(dir);
  writeFileSync(join(dir, 'agent-network.toml'), '[mason]\nidentities = []\n\n[team]\nidentities = []\n');
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = false\n');
  let resolve!: (rows: PairInbound[] | null) => void;
  const response = new Promise<PairInbound[] | null>(r => { resolve = r; });
  let now = 100_000;
  const bridge: PairBridge = {
    async ownHandles() { return []; },
    async baseline() { return 10; },
    async send() { return true; },
    async replies() { return response; },
  };
  const deps = { configDir: dir, bridge, now: () => now };
  const file = (name: string) => readFileSync(join(dir, name), 'utf8');
  return { deps, resolve, file, advance: () => { now += 1000; } };
}

it.each(['YES', 'hello'])('ignores a superseded poll returning %s', async text => {
  const s = setup();
  await startOwnerPair(s.deps, { handle: 'fake-a' });
  const poll = checkOwnerPair(s.deps);
  s.advance();
  await startOwnerPair(s.deps, { handle: 'fake-b' });
  const state = s.file('comms/owner-pair.json');
  const network = s.file('agent-network.toml');
  const comms = s.file('comms.toml');
  s.resolve([{ rowid: 11, handle: 'fake-a', text }]);
  expect(await poll).toEqual({ status: 'waiting' });
  expect(s.file('comms/owner-pair.json')).toBe(state);
  expect(s.file('agent-network.toml')).toBe(network);
  expect(s.file('comms.toml')).toBe(comms);
});

it('accepts a current invitation YES and rejects unrelated handles', async () => {
  const s = setup();
  await startOwnerPair(s.deps, { handle: 'fake-a' });
  const poll = checkOwnerPair(s.deps);
  s.resolve([{ rowid: 11, handle: 'fake-other', text: 'YES' }, { rowid: 12, handle: 'fake-a', text: 'YES' }]);
  expect(await poll).toEqual({ status: 'bound', confirmed: true });
  expect(s.file('agent-network.toml')).toContain('fake-a');
  expect(s.file('agent-network.toml')).not.toContain('fake-other');
});

it('does not undo a cursor advanced by another poll', async () => {
  const s = setup();
  await startOwnerPair(s.deps, { handle: 'fake-a' });
  const oldPoll = checkOwnerPair(s.deps);
  const newer = { ...s.deps, bridge: { ...s.deps.bridge, async replies() { return [{ rowid: 12, handle: 'fake-a', text: 'hello' }]; } } };
  expect(await checkOwnerPair(newer)).toEqual({ status: 'waiting' });
  const state = s.file('comms/owner-pair.json');
  s.resolve([{ rowid: 11, handle: 'fake-a', text: 'YES' }]);
  expect(await oldPoll).toEqual({ status: 'waiting' });
  expect(s.file('comms/owner-pair.json')).toBe(state);
  expect(s.file('agent-network.toml')).not.toContain('fake-a');
});
