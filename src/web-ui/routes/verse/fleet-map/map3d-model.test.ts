import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFleetLiveMap, LIVE_MAP_LEVEL, type FleetLiveMap, type LiveMapEdge, type LiveMapNode, type LiveMapNodeKind } from '../../../../core/fleet/live-map.js';
import { layoutLiveMap3D, MAP_VIEW_KEY, projectLayout3D, readMapViewMode, saveMapViewMode } from './map3d-model.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const node = (kind: LiveMapNodeKind, name: string): LiveMapNode => ({ id: kind === 'leader' ? 'leader' : `${kind}:${name}`, kind, level: LIVE_MAP_LEVEL[kind],
  label: name, provider: 'unknown', status: 'running', detail: 'fixture', live: null });
const reports = (from: string, to: string): LiveMapEdge => ({ id: `reports-to:${from}->${to}`, kind: 'reports-to', from, to, messages: null, lastMessageAt: null, pulse: false });

/** One leader, `lanes` lanes and `jobs` jobs dealt round the lanes. */
function org(lanes: number, jobs: number): FleetLiveMap {
  const base = buildFleetLiveMap({ now: NOW });
  const laneNodes = Array.from({ length: lanes }, (_, i) => node('lane', `lane${i}`));
  const jobNodes = Array.from({ length: jobs }, (_, i) => node('job', `job${i}`));
  return { ...base, nodes: [node('leader', 'Leader'), ...laneNodes, ...jobNodes],
    edges: [...laneNodes.map(lane => reports(lane.id, 'leader')), ...jobNodes.map((job, i) => reports(job.id, laneNodes[i % lanes]!.id))] };
}

describe('layoutLiveMap3D', () => {
  it('empty map: nothing placed, no size', () => {
    const layout = layoutLiveMap3D({ ...buildFleetLiveMap({ now: NOW }), nodes: [], edges: [] });
    expect(layout).toMatchObject({ nodes: [], radius: 0, height: 0 });
    expect(projectLayout3D(layout, 0, 800, 480).size).toBe(0);
  });

  it('one leader, 3 lanes, 5 jobs: leader on the axis on top, then a lane ring, then a job ring with jobs near their lane', () => {
    const layout = layoutLiveMap3D(org(3, 5));
    expect(layout.nodes).toHaveLength(9);
    const leader = layout.at.get('leader')!, lanes = layout.nodes.filter(n => n.kind === 'lane'), jobs = layout.nodes.filter(n => n.kind === 'job');
    expect([leader.x, leader.z]).toEqual([0, 0]);
    expect(new Set(lanes.map(n => n.y)).size).toBe(1);
    expect(new Set(jobs.map(n => n.y)).size).toBe(1);
    expect(leader.y).toBeLessThan(lanes[0]!.y);
    expect(lanes[0]!.y).toBeLessThan(jobs[0]!.y);
    expect(leader.y + jobs[0]!.y).toBe(0); // centred on the origin
    // Jobs are ordered round the ring by their lane: lane0's jobs first, then lane1's, then lane2's.
    expect(jobs.map(n => n.label)).toEqual(['job0', 'job3', 'job1', 'job4', 'job2']);
    const radius = (n: { x: number; z: number }) => Math.hypot(n.x, n.z);
    for (const lane of lanes) expect(radius(lane)).toBeCloseTo(radius(lanes[0]!), 0);
    expect(layout.radius).toBeGreaterThan(0);
  });

  it('projects every node inside the box, leader above the lanes and lanes above the jobs, at any angle', () => {
    const layout = layoutLiveMap3D(org(3, 5));
    for (const yaw of [0, 45, 90, 180, 270]) {
      const at = projectLayout3D(layout, yaw, 800, 480);
      for (const p of at.values()) {
        expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(800);
        expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(480);
      }
      const ys = (kind: LiveMapNodeKind) => layout.nodes.filter(n => n.kind === kind).map(n => at.get(n.id)!.y);
      expect(Math.max(...ys('leader'))).toBeLessThan(Math.min(...ys('lane')));
      expect(Math.max(...ys('lane'))).toBeLessThan(Math.min(...ys('job')));
    }
    // Turning moves ring nodes; the leader on the axis stays put.
    const a = projectLayout3D(layout, 0, 800, 480), b = projectLayout3D(layout, 90, 800, 480);
    expect(b.get('lane:lane0')!.x).not.toBeCloseTo(a.get('lane:lane0')!.x, 0);
    expect(b.get('leader')!.x).toBeCloseTo(a.get('leader')!.x, 5);
  });

  it('200 nodes: layout and a projection stay under 50 ms', () => {
    const map = org(20, 179);
    expect(map.nodes).toHaveLength(200);
    const start = performance.now();
    const layout = layoutLiveMap3D(map);
    projectLayout3D(layout, 30, 1200, 480);
    expect(performance.now() - start).toBeLessThan(50);
    expect(layout.nodes).toHaveLength(200);
    expect(new Set(layout.nodes.map(n => `${n.x},${n.y},${n.z}`)).size).toBe(200);
  });
});

describe('the remembered 2D/3D choice', () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('defaults to 2D, remembers 3D, and falls back to 2D when storage is blocked', () => {
    expect(readMapViewMode()).toBe('2d');
    saveMapViewMode('3d');
    expect(localStorage.getItem(MAP_VIEW_KEY)).toBe('3d');
    expect(readMapViewMode()).toBe('3d');
    localStorage.setItem(MAP_VIEW_KEY, 'sideways');
    expect(readMapViewMode()).toBe('2d');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => saveMapViewMode('3d')).not.toThrow();
    expect(readMapViewMode()).toBe('2d');
  });
});
