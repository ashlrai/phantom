import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { ComputeNode } from '../../../../core/fleet/compute-view.js';
import type { MapSession } from '../../../../core/fleet/sessions-view.js';
import { ComputeScene3D } from './ComputeScene3D.js';
import { ComputeMap } from './ComputeMap.js';
import { buildScene, heatColor, makeFrame, pickAgent, project, UNKNOWN_COLOR } from './scene3d-model.js';
import { at, lane, NOW, sessions } from './company.test-support.js';

const stats = (load: number | null) => ({ sampledAtMs: NOW, uptimeSeconds: 5, load: [load, 1, 1], ramTotal: 1, ramUsed: 1, diskFree: null, cores: [{ total: 1, idle: 1 }, { total: 1, idle: 1 }] });
const node = (id: string, load: number | null | 'none', state: ComputeNode['state'] = 'ready'): ComputeNode => ({
  id, local: false, owners: [], heartbeatAt: NOW, state, slots: null, ramSlots: null, jobs: [], pressure: null, memguardPaused: null,
  stats: load === 'none' ? null : stats(load),
});
const job = (id: string, nodeId: string | null, mapState: MapSession['mapState'] = 'running'): MapSession => ({
  job: id, lane: 'l', model: null, status: 'running', elapsedSeconds: 1, outcome: null, prUrl: null, nodeId,
  placement: 'process', mapState, branch: null, worktree: null, activity: null, detailSources: null,
});
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('lays out deterministically regardless of input order, one platform per node', () => {
  const a = buildScene([node('b', 1), node('a', 1), node('c', 1)], [], NOW, true);
  const b = buildScene([node('c', 1), node('a', 1), node('b', 1)], [], NOW, true);
  expect(a.nodes.map(n => n.id)).toEqual(['a', 'b', 'c']);
  expect(Array.from(a.points)).toEqual(Array.from(b.points));
});
it('maps heat against the 2×CPU ceiling and keeps unknown neutral gray', () => {
  const s = buildScene([node('hot', 4), node('cool', 0.5), node('nostats', 'none'), node('nullload', null)], [], NOW, true);
  const by = Object.fromEntries(s.nodes.map(n => [n.id, n]));
  expect(by.hot!.heat).toBe(1); expect(by.cool!.heat).toBe(0.125);
  expect(by.nostats!.heat).toBeNull(); expect(by.nostats!.color).toBe(UNKNOWN_COLOR);
  expect(by.nullload!.color).toBe(UNKNOWN_COLOR);
  expect(by.hot!.color).not.toBe(by.cool!.color);
  expect(heatColor(null)).toBe(UNKNOWN_COLOR);
  expect(buildScene([node('hot', 4)], [], NOW, false).nodes[0]!.color).toBe(UNKNOWN_COLOR);
  expect(buildScene([node('stale', 4)], [], NOW + 200_000, true).nodes[0]!.heat).toBeNull();
});
it('aggregates agent overflow per node and ignores unplaced agents', () => {
  const jobs = [...Array.from({ length: 15 }, (_, i) => job(`J${String(i).padStart(2, '0')}`, 'a')), job('Q', null, 'queued'), job('B', 'b', 'held')];
  const s = buildScene([node('a', 1), node('b', 1)], jobs, NOW, true);
  expect(s.shown).toBe(11 + 1); expect(s.overflow).toBe(4);
  expect(s.agents.filter(a => a.kind === 'more').map(a => a.label)).toEqual(['+4 more']);
  expect(s.agents.some(a => a.job === 'Q')).toBe(false);
  expect(s.agents.find(a => a.job === 'B')!.kind).toBe('held');
});
it('projects into preallocated buffers and picks the nearest real agent, never the aggregate', () => {
  const s = buildScene([node('a', 1)], Array.from({ length: 13 }, (_, i) => job(`J${String(i).padStart(2, '0')}`, 'a')), NOW, true);
  const f = makeFrame(s), sx = f.sx;
  project(s, f, 600, 460, 20, 15, 1); expect(f.sx).toBe(sx);
  const a = s.agents[0]!;
  expect(pickAgent(s, f, f.sx[a.top]!, f.sy[a.top]!)?.job).toBe('J00');
  const more = s.agents.at(-1)!; expect(more.kind).toBe('more');
  expect(pickAgent(s, f, f.sx[more.top]!, f.sy[more.top]!)?.kind).not.toBe('more');
  expect(pickAgent(s, f, -500, -500)).toBeNull();
});

// jsdom has no PointerEvent, so coordinates are attached by hand.
function ptr(type: 'pointerDown' | 'pointerMove' | 'pointerUp', el: Element, clientX: number, clientY: number) {
  const ev = createEvent[type](el); Object.defineProperties(ev, { clientX: { value: clientX }, clientY: { value: clientY } }); fireEvent(el, ev);
}
function stubCanvas() {
  const ctx = new Proxy({}, { get: (_t, k) => k === 'measureText' ? () => ({ width: 1 }) : vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  return ctx;
}
it('draws, selects an agent on click, and degrades without a 2D context', () => {
  stubCanvas();
  const onSelect = vi.fn();
  render(<ComputeScene3D nodes={[node('a', 1)]} jobs={[job('J1', 'a')]} now={NOW} heat yaw={0} tilt={15} zoom={1} selection={null} onSelect={onSelect} onOrbit={() => {}} />);
  const c = screen.getByTestId('scene3d');
  expect(c).toHaveAttribute('aria-label', expect.stringContaining('1 nodes, 1 agents shown'));
  // jsdom rect is 0,0 so pointer coords equal client coords; click the marker's projected position.
  const s = buildScene([node('a', 1)], [job('J1', 'a')], NOW, true), f = makeFrame(s);
  project(s, f, 640, 460, 0, 15, 1);
  ptr('pointerDown', c, 1, 1);
  ptr('pointerUp', c, f.sx[s.agents[0]!.top]!, f.sy[s.agents[0]!.top]!);
  expect(onSelect).toHaveBeenCalledWith('J1');
});
it('does not select when the pointer was a drag, and reports orbit', () => {
  stubCanvas(); const onSelect = vi.fn(), onOrbit = vi.fn();
  render(<ComputeScene3D nodes={[node('a', 1)]} jobs={[job('J1', 'a')]} now={NOW} heat yaw={0} tilt={0} zoom={1} selection={null} onSelect={onSelect} onOrbit={onOrbit} />);
  const c = screen.getByTestId('scene3d');
  ptr('pointerDown', c, 100, 100); ptr('pointerMove', c, 150, 100); ptr('pointerUp', c, 150, 100);
  expect(onOrbit).toHaveBeenCalledWith(20, 0); expect(onSelect).not.toHaveBeenCalled();
});
it('does not throw when no canvas context exists', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  expect(() => render(<ComputeScene3D nodes={[node('a', 1)]} jobs={[]} now={NOW} heat yaw={0} tilt={0} zoom={1} selection={null} onSelect={() => {}} onOrbit={() => {}} />)).not.toThrow();
  expect(screen.getByText(/1 nodes/)).toBeInTheDocument();
});

it('toggles between the 2D machine list and the 3D scene on the same data', async () => {
  stubCanvas();
  const compute = { schema: 'fleet.compute.v1', generatedAt: at(), localNodeId: 'a', truncated: false, sources: {}, dispatcherAt: null, lanes: {}, nodes: [node('a', 1), node('b', 'none')] };
  const payloads: Record<string, unknown> = {
    '/api/verse/fleet/control/compute': compute,
    '/api/verse/fleet/control/sessions': { ...sessions, computeAt: at(), mapRecent: [], mapSessions: [job('RQ-A', 'a')] },
    '/api/fleet/lanes': { schema: 'fleet.lanes.v1', generatedAt: at(), lanes: [lane] },
  };
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => Response.json(payloads[String(u)] ?? {}, { status: payloads[String(u)] ? 200 : 503 })));
  render(<ComputeMap visible />);
  await screen.findByText('RQ-A');
  expect(screen.queryByTestId('scene3d')).toBeNull();
  fireEvent.click(screen.getByText('3D'));
  expect(screen.getByTestId('scene3d')).toHaveAttribute('aria-label', expect.stringContaining('2 nodes, 1 agents shown'));
  expect(screen.getByText('RQ-A')).toBeInTheDocument();
  fireEvent.click(screen.getByText('2D'));
  expect(screen.queryByTestId('scene3d')).toBeNull();
});
