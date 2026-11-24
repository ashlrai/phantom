/** `phm nodes --discover`: Tailscale computers that have not joined, in plain words. No real network. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import type { HostStats, NodeRecord } from '../src/core/drive/nodes/state.js';
import { readNodesView, type NodesRegistry, type NodesViewDeps } from '../src/core/fleet/nodes-view.js';
import { narrowComputers } from '../src/web-ui/routes/verse/fleet-host/computers-model.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const stats: HostStats = { sampledAtMs: NOW, uptimeSeconds: 60, load: [1, 1, 1], ramTotal: 32 * 1024 ** 3, ramUsed: 8 * 1024 ** 3, diskFree: null, cores: [{ total: 100, idle: 50 }] };
const joinedNode: NodeRecord = { nodeId: 'laptop-two', session: 1, heartbeatAt: NOW - 2_000, expiresAt: NOW + 30_000, caps: ['claude'], slots: 1 };
const registry: NodesRegistry = { source: 'pool-witness', selfNode: 'desk-mac', state: { version: 'drive.nodes.v1', sequence: 1, observedAt: NOW - 1_000, nodes: [joinedNode], leader: null, jobs: [] } };
const peer = (HostName: string, Online: boolean) => ({ HostName, OS: 'macOS', Online, LastSeen: '2026-11-17T10:42:00Z' });
const status = (peers: unknown[]) => JSON.stringify({ BackendState: 'Running', Self: { HostName: 'desk-mac' }, Peer: Object.fromEntries(peers.map((p, i) => [`p${i}`, p])) });
const deps = (raw: string | null): NodesViewDeps => ({
  peers: { now: () => new Date(NOW), homeDir: () => '/fake-home', exec: () => { if (raw === null) throw new Error('missing'); return raw; } },
  readRegistry: () => registry, localStats: () => stats, hostName: () => 'desk-mac', timeZone: 'UTC',
});
const TWO_ONLINE_ONE_OFF = status([peer('laptop-two', true), peer('studio-mac', true), peer('old-mini', false)]);

async function run(args: string[], raw: string | null): Promise<{ code: number; out: string }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdNodes(args, deps(raw));
  const out = log.mock.calls.map(c => String(c[0])).join('\n');
  return { code, out };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('phm nodes --discover', () => {
  it('marks joined and not joined rows and gives the one join command', () => {
    const rows = readNodesView(deps(TWO_ONLINE_ONE_OFF)).nodes;
    const by = Object.fromEntries(rows.map(r => [r.name, r]));
    expect(by['desk-mac']).toMatchObject({ joined: true, joinCommand: null });
    expect(by['laptop-two']).toMatchObject({ joined: true, joinCommand: null });
    expect(by['studio-mac']).toMatchObject({ joined: false, joinCommand: 'phm node join', reachable: true });
    expect(by['old-mini']).toMatchObject({ joined: false, joinCommand: 'phm node join', reachable: false });
  });

  it('text lists the two online peers and the offline one under Not joined', async () => {
    const { code, out } = await run(['--discover'], TWO_ONLINE_ONE_OFF);
    expect(code).toBe(0);
    expect(out).toContain('Not joined (on your Tailscale network):');
    expect(out).toContain('studio-mac (online): not joined. On studio-mac, run: phm node join');
    expect(out).toContain('old-mini (offline): not joined. On old-mini, run: phm node join');
    expect(out).not.toContain('laptop-two (online): not joined');
  });

  it('json adds discovered with the same rows', async () => {
    const { out } = await run(['--discover', '--json'], TWO_ONLINE_ONE_OFF);
    const body = JSON.parse(out) as { discovered: { name: string; joined: boolean }[]; nodes: { name: string }[] };
    expect(body.discovered.map(r => r.name).sort()).toEqual(['old-mini', 'studio-mac']);
    expect(body.discovered.every(r => !r.joined)).toBe(true);
    expect(body.nodes.length).toBe(4);
  });

  it('without --discover the output has no discovered section', async () => {
    const { out } = await run(['--json'], TWO_ONLINE_ONE_OFF);
    expect(JSON.parse(out)).not.toHaveProperty('discovered');
  });

  it('tailscale missing: says so and finds nothing', async () => {
    const { code, out } = await run(['--discover'], null);
    expect(code).toBe(0);
    expect(out).toContain('No computers waiting to join.');
    expect(out).toContain('tailscale unavailable or status unreadable');
  });

  it('malformed status: says so and finds nothing', async () => {
    const { out } = await run(['--discover', '--json'], '{not json');
    const body = JSON.parse(out) as { discovered: unknown[]; reasons: string[] };
    expect(body.discovered).toEqual([]);
    expect(body.reasons).toContain('tailscale unavailable or status unreadable');
  });

  it('the desktop model keeps the flag so not joined computers render grey', async () => {
    const { out } = await run(['--discover', '--json'], TWO_ONLINE_ONE_OFF);
    const cards = narrowComputers(JSON.parse(out))!.computers;
    expect(cards.find(c => c.name === 'studio-mac')).toMatchObject({ joined: false, joinCommand: 'phm node join' });
    expect(cards.find(c => c.name === 'laptop-two')).toMatchObject({ joined: true, joinCommand: null });
  });
});
