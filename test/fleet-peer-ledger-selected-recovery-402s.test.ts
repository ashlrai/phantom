import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetPeerLedger } from '../src/cli/fleet-peer-ledger.js';
import { useAccountHomeForTest, useProcessHomeForTest } from '../src/core/real-home.js';

const NOW = 1_800_000_000_000;
const DIGEST = 'a'.repeat(64), THREAD = 'fixture-private-thread-402s';
const lookup = ['--from-agent', 'fx-zz', '--target', 'fx-zy'];
let home = '', out = '', err = '';
const originalHome = process.env.HOME;

afterEach(() => {
  vi.restoreAllMocks();
  useAccountHomeForTest();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

it('reads selected evidence afresh through default private storage across a reconnect', async () => {
  home = mkdtempSync(join(tmpdir(), 'peer-reconnect-'));
  process.env.HOME = home;
  useProcessHomeForTest();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out += String(s); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { err += String(s); return true; });
  const file = join(home, '.ashlr', 'fleet', 'agentnet', 'coordination.json');
  mkdirSync(join(home, '.ashlr', 'fleet', 'agentnet'), { recursive: true, mode: 0o700 });
  let id = 0;
  const row = (fromAgent: string, target: string, at: number) => ({
    id: `peer-123e4567-e89b-12d3-a456-426614${(id++).toString(16).padStart(6, '0')}`,
    fromAgent, target, origin: 'peer-123e4567-e89b-12d3-a456-426614174000',
    digest: DIGEST, threadId: THREAD, hopCount: 1, at,
  });
  const decoys = Array.from({ length: 65 }, (_, i) => Array.from({ length: 6 }, (_, k) =>
    row(`fx-a${String(i).padStart(2, '0')}`, `fx-b${String(i).padStart(2, '0')}`, NOW - 1000 - k))).flat();
  const write = (rows: unknown[]) => writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
  write([...decoys, ...Array.from({ length: 6 }, (_, k) => row('fx-zz', 'fx-zy', NOW - 1000 - k))]);
  const run = async (args: string[], expected: number, fixture?: Buffer) => {
    out = ''; err = '';
    expect(await cmdFleetPeerLedger(args)).toBe(expected);
    expect(err).toBe('');
    for (const privateValue of [DIGEST, THREAD, home, file]) expect(out).not.toContain(privateValue);
    if (fixture) expect(readFileSync(file)).toEqual(fixture);
    return out;
  };
  const initial = readFileSync(file);
  const all = JSON.parse(await run(['--json'], 0, initial));
  expect(all.pairs).toHaveLength(64);
  expect(all.truncated.pairs).toBe(true);
  expect(all.pairs.some((p: { fromAgent: string }) => p.fromAgent === 'fx-zz')).toBe(false);
  const first = JSON.parse(await run([...lookup, '--json'], 0, initial));
  expect(first).toMatchObject({ status: 'ok', authority: 'none', asOf: new Date(NOW).toISOString(),
    selection: { fromAgent: 'fx-zz', target: 'fx-zy', match: 'exact' },
    pairs: [{ inWindow: 6, remaining: 0, retryAt: new Date(NOW - 1005 + 60_000).toISOString() }] });
  expect(await run(lookup, 0, initial)).toContain('fx-zz -> fx-zy  6/6  remaining 0  blocked; retry at:');

  renameSync(file, `${file}.offline`);
  clock.mockReturnValue(NOW + 10_000);
  const missing = JSON.parse(await run([...lookup, '--json'], 0));
  expect(missing).toMatchObject({ status: 'empty', authority: 'none', asOf: new Date(NOW + 10_000).toISOString(),
    selection: { fromAgent: 'fx-zz', target: 'fx-zy', match: 'none' }, pairs: [] });
  expect(readFileSync(`${file}.offline`)).toEqual(initial);
  expect(await run(lookup, 0)).toContain('pair lookup: fx-zz -> fx-zy (no live evidence)');
  mkdirSync(file);
  const unavailable = JSON.parse(await run([...lookup, '--json'], 1));
  expect(unavailable).toMatchObject({ status: 'unavailable', reason: 'peer-ledger-unreadable', authority: 'none',
    asOf: new Date(NOW + 10_000).toISOString(), selection: { match: 'none' }, pairs: [] });
  expect(await run(lookup, 1)).toContain('pair lookup: fx-zz -> fx-zy (unavailable)');
  expect(readFileSync(`${file}.offline`)).toEqual(initial);
  rmSync(file, { recursive: true });
  write([...decoys, row('fx-zz', 'fx-zy', NOW + 9_000)]);
  const restored = readFileSync(file);
  clock.mockReturnValue(NOW + 20_000);
  const fresh = JSON.parse(await run([...lookup, '--json'], 0, restored));
  expect(fresh).toMatchObject({ status: 'ok', authority: 'none', asOf: new Date(NOW + 20_000).toISOString(),
    selection: { fromAgent: 'fx-zz', target: 'fx-zy', match: 'exact' },
    pairs: [{ inWindow: 1, remaining: 5, retryAt: null, lastAt: new Date(NOW + 9_000).toISOString() }] });
  expect(await run(lookup, 0, restored)).toContain('fx-zz -> fx-zy  1/6  remaining 5');
});
