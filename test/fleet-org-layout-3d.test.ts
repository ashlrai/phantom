import { describe, expect, it, vi } from 'vitest';
import { buildFleetLiveMap, type LiveMapEdge, type LiveMapNode } from '../src/core/fleet/live-map.js';
import { fleetOrgGroups, UNASSIGNED_GROUP } from '../src/core/fleet/org-groups.js';
import { layoutOrgGroups3D, orgLayoutOf, ORG_LAYER } from '../src/core/fleet/org-layout-3d.js';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/verse/fleet-live-map-api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/verse/fleet-live-map-api.js')>(), readFleetLiveMap: mocks.read }));
import { cmdMap } from '../src/cli/map.js';

const node = (kind: LiveMapNode['kind'], id: string, status = 'running'): LiveMapNode =>
  ({ id, kind, level: 0, label: id, provider: 'unknown', status, detail: 'x', live: null });
const reports = (from: string, to: string): LiveMapEdge =>
  ({ id: `reports-to:${from}->${to}`, kind: 'reports-to', from, to, messages: null, lastMessageAt: null, pulse: false });
const map = (nodes: LiveMapNode[], edges: LiveMapEdge[] = []) => ({ generatedAt: '2026-11-18T00:00:00Z', nodes, edges });
const spot = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const at = (layout: ReturnType<typeof orgLayoutOf>, id: string) => layout.positions.find(row => row.id === id)!;

describe('layoutOrgGroups3D', () => {
  const three = map(
    [node('leader', 'leader'), node('lane', 'lane:a'), node('job', 'job:1'), node('job', 'job:2', 'queued'), node('lane', 'lane:b', 'idle'), node('job', 'job:3', 'stale')],
    [reports('lane:a', 'leader'), reports('lane:b', 'leader'), reports('job:1', 'lane:a'), reports('job:2', 'lane:a'), reports('job:3', 'lane:b')]);

  it('three levels: depth is the vertical axis, the leader is on it, children sit round their parent one level down', () => {
    const layout = orgLayoutOf(three);
    expect(layout.positions.map(row => row.id)).toEqual(['leader', 'lane:a', 'job:1', 'job:2', 'lane:b', 'job:3']);
    expect(at(layout, 'leader')).toMatchObject({ depth: 0, x: 0, z: 0, y: -ORG_LAYER });
    expect(at(layout, 'lane:a').y).toBe(0);
    expect(at(layout, 'job:1').y).toBe(ORG_LAYER);
    const near = (child: string, parent: string) => Math.hypot(at(layout, child).x - at(layout, parent).x, at(layout, child).z - at(layout, parent).z);
    // Each job is closer to its own lane than to the other lane.
    expect(near('job:1', 'lane:a')).toBeLessThan(Math.hypot(at(layout, 'job:1').x - at(layout, 'lane:b').x, at(layout, 'job:1').z - at(layout, 'lane:b').z));
    expect(near('job:3', 'lane:b')).toBe(0); // an only child sits straight below its parent
    expect(new Set(layout.positions.map(spot)).size).toBe(6);
    expect(layout.height).toBe(2 * ORG_LAYER);
  });

  it('labels each lane with its name and running count', () => {
    const labels = orgLayoutOf(three).labels;
    expect(labels.map(label => label.text)).toEqual(['lane:a: 1 running', 'lane:b: 0 running, 1 unknown']);
  });

  it('a node with no owner goes in a cluster named "Other", never dropped', () => {
    const layout = orgLayoutOf(map([node('leader', 'leader'), node('lane', 'lane:a'), node('job', 'job:x'), node('job', 'job:y')], [reports('lane:a', 'leader')]));
    expect(layout.positions.map(row => row.id)).toEqual(expect.arrayContaining(['job:x', 'job:y', UNASSIGNED_GROUP]));
    expect(at(layout, 'job:x').parent).toBe(UNASSIGNED_GROUP);
    expect(at(layout, UNASSIGNED_GROUP)).toMatchObject({ role: 'group', label: 'Other' });
    expect(layout.labels.find(label => label.id === UNASSIGNED_GROUP)!.text).toBe('Other: 2 running');
    expect(new Set(layout.positions.map(spot)).size).toBe(layout.positions.length);
  });

  it('an empty fleet has just the leader; no map at all has nothing', () => {
    const empty = orgLayoutOf(map([]));
    expect(empty.positions.map(row => row.id)).toEqual(['leader']);
    expect(empty).toMatchObject({ labels: [], hidden: [], radius: 0, height: 0 });
    expect(layoutOrgGroups3D({ schema: 'fleet.org-groups.v1', generatedAt: '', root: 'leader', nodes: [], duplicates: [] }).positions).toEqual([]);
  });

  it('a single node sits on the axis', () => {
    const layout = orgLayoutOf(map([node('leader', 'leader'), node('lane', 'lane:a')], [reports('lane:a', 'leader')]));
    expect(layout.positions.map(row => [row.x, row.z])).toEqual([[0, 0], [0, 0]]);
    expect(layout.positions.map(row => row.y)).toEqual([-ORG_LAYER / 2, ORG_LAYER / 2]);
  });

  it('200 nodes in one group never share a position, even beside a second group', () => {
    const jobs = Array.from({ length: 200 }, (_, i) => node('job', `job:${i}`));
    const layout = orgLayoutOf(map([node('leader', 'leader'), node('lane', 'lane:a'), node('lane', 'lane:b'), node('job', 'job:other'), ...jobs],
      [reports('lane:a', 'leader'), reports('lane:b', 'leader'), reports('job:other', 'lane:b'), ...jobs.map(job => reports(job.id, 'lane:a'))]));
    expect(layout.positions).toHaveLength(204);
    expect(new Set(layout.positions.map(spot)).size).toBe(204);
    expect(layout.labels.find(label => label.id === 'lane:a')!.running).toBe(200);
  });

  it('the same input gives the same output twice, whatever order the layout is asked in', () => {
    const first = JSON.stringify(orgLayoutOf(three)), again = JSON.stringify(orgLayoutOf(JSON.parse(JSON.stringify(three))));
    expect(again).toBe(first);
    expect(JSON.stringify(layoutOrgGroups3D(fleetOrgGroups(three)))).toBe(first);
  });

  it('a collapsed group shows only itself and its label counts what is hidden', () => {
    const layout = orgLayoutOf(three, new Set(['lane:a']));
    expect(layout.positions.map(row => row.id)).toEqual(['leader', 'lane:a', 'lane:b', 'job:3']);
    expect(layout.hidden).toEqual(['job:1', 'job:2']);
    expect(layout.labels[0]!.text).toBe('lane:a: 1 running, 2 hidden');
  });
});

describe('phm map --json', () => {
  it('carries the grouped positions in orgLayout, the same as the layout function', async () => {
    const live = buildFleetLiveMap({ now: Date.parse('2026-11-18T00:00:00Z') });
    mocks.read.mockResolvedValue(live);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdMap(['--json'])).toBe(0);
    const out = JSON.parse(String(log.mock.calls.at(-1)![0]));
    log.mockRestore();
    expect(out.orgLayout).toEqual({ schema: 'fleet.org-layout3d.v1', positions: [expect.objectContaining({ id: 'leader', role: 'leader', depth: 0, x: 0, y: 0, z: 0 })],
      labels: [], hidden: [], radius: 0, height: 0 });
    expect(Object.keys(out.orgLayout)).toEqual(['schema', 'positions', 'labels', 'hidden', 'radius', 'height']);
    expect(Object.keys(out.orgLayout.positions[0])).toEqual(['id', 'role', 'label', 'parent', 'depth', 'x', 'y', 'z']);
    expect(out.orgLayout).toEqual(orgLayoutOf(live));
  }, 30_000);
});
