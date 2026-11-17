import { expect, it } from 'vitest';
import { summarizeHosts } from '../src/core/fleet/compute-hosts.js';
import type { ComputeNode } from '../src/core/fleet/compute-view.js';

const NOW = 1_700_000_000_000, GIB = 1024 ** 3;
const node = (id: string, ram: number, cores: number, boot: number, over: Partial<ComputeNode> = {}): ComputeNode => {
  const sampledAtMs = NOW + Math.round(Math.random() * 3000); // workers sample at different instants
  return { id, local: false, owners: ['ashlr'], heartbeatAt: NOW, state: 'ready', slots: 1, ramSlots: null, jobs: [], pressure: null, memguardPaused: null,
    caps: ['codex'], stats: { sampledAtMs, uptimeSeconds: Math.floor((sampledAtMs - boot) / 1000), load: [0, 0, 0], ramTotal: ram * GIB, ramUsed: GIB, diskFree: null,
      cores: Array.from({ length: cores }, () => ({ total: 1, idle: 1 })) }, ...over };
};

it('groups workers per Mac and shows oversubscription against each RAM budget', () => {
  const mbp = NOW - 86_400_000, muse = NOW - 7_200_000, air = NOW - 3_600_000;
  const nodes = [
    node('mbp-w1', 128, 18, mbp, { slots: 22 }), node('mbp-w2', 128, 18, mbp, { slots: 22 }),
    node('muse', 8, 8, muse), ...[2, 3, 4, 5, 6, 7, 8].map(i => node(`muse-w${i}`, 8, 8, muse)),
    ...[1, 2, 3, 4].map(i => node(`air-w${i}`, 16, 10, air, { slots: 2, caps: ['codex', 'claude'] })),
  ];
  const { hosts, totals } = summarizeHosts(nodes);
  expect(hosts.map(h => h.id)).toEqual(['air-w1', 'mbp-w1', 'muse']);
  const byId = Object.fromEntries(hosts.map(h => [h.id, h]));
  expect(byId['mbp-w1']).toMatchObject({ liveWorkers: 2, liveSlots: 44, oversubscribed: false });
  expect(byId['muse']).toMatchObject({ liveWorkers: 8, liveSlots: 8, ramSlots: 4, oversubscribed: true, inferred: true });
  expect(byId['air-w1']).toMatchObject({ liveSlots: 8, caps: ['claude', 'codex'], oversubscribed: false });
  expect(totals).toMatchObject({ hosts: 3, liveWorkers: 14, liveSlots: 60, oversubscribedHosts: 1, unplacedNodes: 0 });
});

it('never fabricates: offline workers are not live, missing telemetry is unplaced, unreported slots make sums unknown', () => {
  const boot = NOW - 1_000_000;
  const { hosts, totals } = summarizeHosts([
    node('a', 16, 10, boot, { slots: 2 }), node('b', 16, 10, boot, { state: 'offline', slots: 2 }),
    node('c', 16, 10, boot, { slots: null }), node('ghost', 16, 10, boot, { stats: null }),
  ]);
  expect(hosts).toHaveLength(1);
  expect(hosts[0]).toMatchObject({ liveWorkers: 2, liveSlots: null, oversubscribed: null });
  expect(totals).toMatchObject({ liveSlots: null, unplacedNodes: 1 });
});

it('keeps same-shape Macs with different boot times apart and counts held workers', () => {
  const { hosts } = summarizeHosts([node('x', 16, 10, NOW - 1_000_000, { slots: 0 }), node('y', 16, 10, NOW - 9_000_000)]);
  expect(hosts.map(h => h.nodeIds)).toEqual([['x'], ['y']]);
  expect(hosts[0]).toMatchObject({ heldWorkers: 1, liveSlots: 0 });
});
