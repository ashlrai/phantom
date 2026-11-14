import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetPoolReach } from '../src/cli/fleet-pool-reach.js';
import type { PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const HOME = '/Users/fakeuser';
const T1 = Date.parse('2026-11-14T12:00:00.000Z');
const T2 = Date.parse('2026-11-14T12:00:30.000Z');
const MARKER = 'PRIVATE-DIAG-357s-FAKE-MARKER-9f8e7d6c';
const CONFIG: PoolConfig = { role: 'worker', primary: 'mac-primary', backup: 'mac-backup', owner: 'fake-owner', node: 'fake-node' };
const PEERS = {
  'nodekey:a': { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:00.000Z' },
  'nodekey:b': { HostName: 'mac-backup', OS: 'macOS', Online: false, LastSeen: '2026-11-14T11:59:00.000Z' },
};

afterEach(() => vi.restoreAllMocks());

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  return { out, err };
}

it('pool-reach CLI prints a fixed unreadable reason for a throwing config reader, then fresh recovered hosts', async () => {
  let failing = true;
  let now = T1;
  const readConfig = vi.fn((): PoolConfig | null => {
    if (failing) throw new Error(`pool parse failed: ${MARKER} near ${HOME}/.ashlr/node-pool/config.json`);
    return CONFIG;
  });
  const exec = vi.fn((_cmd: string, _args: readonly string[]) => JSON.stringify({ Self: { HostName: 'mac-self' }, Peer: PEERS }));
  const deps: PoolReachDeps = { readConfig, peers: { now: () => new Date(now), homeDir: () => HOME, exec } };

  const first = capture();
  expect(await cmdFleetPoolReach(['--json'], deps)).toBe(0);
  const parsed = JSON.parse(first.out.join('\n')) as { role: string; hosts: unknown[]; reasons: string[] };
  expect(parsed).toMatchObject({ role: 'unknown', hosts: [], reasons: ['pool config: pool config unreadable'] });
  const shown = first.out.join('\n') + first.err.join('\n');
  for (const leak of [MARKER, 'pool parse failed', HOME, 'mac-primary', 'mac-backup']) expect(shown).not.toContain(leak);

  const second = capture();
  expect(await cmdFleetPoolReach([], deps)).toBe(0);
  const human = second.out.join('\n');
  expect(human).toContain('role unknown');
  expect(human).toContain('reason: pool config: pool config unreadable');
  expect(human).not.toContain(MARKER);
  expect(human).not.toContain('online');

  failing = false;
  now = T2;
  const third = capture();
  expect(await cmdFleetPoolReach(['--json'], deps)).toBe(0);
  const recovered = JSON.parse(third.out.join('\n')) as {
    asOf: string; role: string; reasons: string[]; hosts: { slot: string; matched: string; online: unknown }[];
  };
  expect(recovered.asOf).toBe(new Date(T2).toISOString());
  expect(recovered.role).toBe('worker');
  expect(recovered.hosts.map(host => host.slot)).toEqual(['primary', 'backup']);
  expect(recovered.hosts[0]).toMatchObject({ matched: 'mac-primary', online: true });
  expect(recovered.hosts[1]).toMatchObject({ matched: 'mac-backup', online: false });
  expect(recovered.reasons).toEqual([]);

  expect(readConfig).toHaveBeenCalledTimes(3);
  expect(exec).toHaveBeenCalledTimes(3);
  for (const call of exec.mock.calls) expect(call).toEqual(['tailscale', ['status', '--json']]);
});
