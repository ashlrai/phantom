/** Other Macs are drawn as their own labelled group, apart from this Mac; the live map marks them `remote`. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { buildFleetLiveMap } from '../../../../core/fleet/live-map.js';
import type { NodeRow, NodesView } from '../../../../core/fleet/nodes-view.js';
import { layoutLiveMap, narrowLiveMap, NODE_W } from './map-model.js';
import { MapView } from './MapPane.js';

const AT = '2026-11-17T12:00:00.000Z';
const row = (name: string, extra: Partial<NodeRow> = {}): NodeRow => ({ name, isSelf: false, reachable: true, lastSeen: AT, heartbeatAgeSeconds: 2, phantom: 'running',
  freeMemoryBytes: 'unknown', freeMemoryPercent: 'unknown', load: 'unknown', cpuHeadroomPercent: 'unknown', lanes: ['claude'], jobsRunning: [], freeSlots: 1, stateCode: 'ready', state: 'ready for work', joined: true, joinCommand: null, ...extra });
const computers = (nodes: NodeRow[]): NodesView => ({ schema: 'phantom.nodes-view.v1', schemaVersion: 1, asOf: AT, self: 'alpha', registry: 'local', nodes, reasons: [] });
const live = (nodes: NodeRow[]) => narrowLiveMap(JSON.parse(JSON.stringify(buildFleetLiveMap({ computers: computers(nodes), now: Date.parse(AT) }))))!;
const THREE = [row('zulu', { reachable: false, stateCode: 'offline', state: 'offline' }), row('alpha', { isSelf: true }), row('beta')];
afterEach(cleanup);

it('marks only other Macs remote, and keeps the mark through the pane reader', () => {
  const map = live(THREE);
  expect(map.nodes.filter(node => node.kind === 'computer').map(node => [node.label, node.remote === true])).toEqual([['alpha', false], ['beta', true], ['zulu', true]]);
});

it('puts this Mac first and boxes the other Macs together with a plain label', () => {
  const layout = layoutLiveMap(live(THREE));
  const at = (name: string) => layout.at.get(`computer:${name}`)!;
  expect(at('alpha').x).toBeLessThan(at('beta').x);
  expect(at('beta').x).toBeLessThan(at('zulu').x);
  expect(layout.groups).toHaveLength(1);
  const box = layout.groups![0]!;
  expect(box.label).toBe('Other Macs: 2, 1 offline');
  for (const name of ['beta', 'zulu']) {
    expect(at(name).x - NODE_W / 2).toBeGreaterThanOrEqual(box.x);
    expect(at(name).x + NODE_W / 2).toBeLessThanOrEqual(box.x + box.width);
  }
  expect(at('alpha').x + NODE_W / 2).toBeLessThanOrEqual(box.x);
});

it('draws no group when this is the only Mac', () => {
  expect(layoutLiveMap(live([row('alpha', { isSelf: true })])).groups).toEqual([]);
});

it('renders the group on the map', () => {
  render(<MapView map={live(THREE)} now={Date.parse(AT)} onOpen={() => {}} />);
  const group = screen.getByRole('group', { name: 'Other Macs: 2, 1 offline' });
  expect(group.getAttribute('data-map-group')).toBe('remote-macs');
  expect(within(group).getByText('Other Macs: 2, 1 offline')).toBeTruthy();
});
