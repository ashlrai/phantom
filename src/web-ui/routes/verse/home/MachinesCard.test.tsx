import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNodesPool, poolText } from '../../../../core/fleet/nodes-pool.js';
import type { NodeRow, NodesView } from '../../../../core/fleet/nodes-view.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { MachinesCard, narrowNodesPool } from './MachinesCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => vi.fn() }));

const GIB = 1024 ** 3, AT = '2026-11-17T12:00:00.000Z';
const row = (name: string, extra: Partial<NodeRow> = {}): NodeRow => ({ name, isSelf: false, reachable: true, lastSeen: AT, heartbeatAgeSeconds: 2, phantom: 'running',
  freeMemoryBytes: 12 * GIB, freeMemoryPercent: 37, load: 1.5, cpuHeadroomPercent: 80, lanes: ['claude'], jobsRunning: [], freeSlots: 2, stateCode: 'ready', state: 'ready for work', ...extra });
const view = (nodes: NodeRow[]): NodesView => ({ schema: 'phantom.nodes-view.v1', schemaVersion: 1, asOf: AT, self: 'alpha', registry: 'local', nodes, reasons: [] });
const POOL = buildNodesPool(view([
  row('alpha', { isSelf: true, jobsRunning: ['RQ-ONE'], freeSlots: 3 }),
  row('beta', { reachable: false, lastSeen: '2026-11-17T10:00:00.000Z', stateCode: 'offline', state: 'offline since 10:00', freeSlots: 0 }),
  row('gamma', { freeSlots: 'unknown', freeMemoryBytes: 'unknown', load: 'unknown', stateCode: 'unknown' }),
]), { selfOffload: true, disk: new Map([['alpha', 100 * GIB]]) });
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390, status = 'success') => { viewport = mockViewport(width); state.read = { status, data }; return render(<MachinesCard />); };
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['390 px', 390], ['desktop width', 1440]])('Machines card at %s', (_name, width) => {
  it('shows the total, then this Mac first and each Mac with its status, slots, jobs and offload, with no button', () => {
    show(POOL, width);
    const card = within(screen.getByRole('region', { name: 'Machines' }));
    expect(card.getByText('3 Macs, 3 free slots (1 not measured)')).toBeTruthy();
    const macs = card.getAllByRole('listitem');
    expect(macs.map(item => item.textContent)).toEqual([
      'alpha (this Mac)online3 free slots · running RQ-ONE · load 1.5 · memory free 12.0 GB · disk free 107.4 GB · offload on · seen just now',
      'betaoffline0 free slots · running nothing · load 1.5 · memory free 12.0 GB · disk free unknown · offload unknown · seen 2 h ago',
      'gammaonlinefree slots unknown · running nothing · load unknown · memory free unknown · disk free unknown · offload unknown · seen just now',
    ]);
    expect(macs[1]!.querySelector('[data-status]')!.getAttribute('data-status')).toBe('offline');
    expect(card.getByText('phm nodes pool --json')).toBeTruthy();
    expect(card.queryAllByRole('button')).toHaveLength(0);
  });
});

it('says the same words as the command', () => {
  show(POOL);
  const text = poolText(POOL);
  expect(text.split('\n')[0]).toContain('3 Macs, 3 free slots (1 not measured)');
});

it('stays hidden before the first read, on an older server or on another payload', () => {
  expect(show(undefined).container.textContent).toBe('');
  cleanup(); expect(show({ schema: 'something.else' }).container.textContent).toBe('');
});

it('keeps the last reading but says it could not refresh', () => {
  show(POOL, 390, 'error');
  expect(screen.getByRole('status').textContent).toBe('Machines could not refresh. Showing the last reading.');
  expect(screen.getByText('3 Macs, 3 free slots (1 not measured)')).toBeTruthy();
});

it('invites joining a Mac when none is known', () => {
  show(buildNodesPool(view([]), { selfOffload: null }));
  expect(screen.getByText('0 Macs, 0 free slots')).toBeTruthy();
  expect(screen.getByText(/No Macs known/)).toBeTruthy();
});

describe('narrowNodesPool', () => {
  it('accepts a real report and refuses a bad status, a bad count and the wrong schema', () => {
    expect(narrowNodesPool(JSON.parse(JSON.stringify(POOL)))).not.toBeNull();
    expect(narrowNodesPool({ ...POOL, schema: 'x' })).toBeNull();
    expect(narrowNodesPool({ ...POOL, nodes: [{ ...POOL.nodes[0], status: 'sleeping' }] })).toBeNull();
    expect(narrowNodesPool({ ...POOL, nodes: [{ ...POOL.nodes[0], freeSlots: -1 }] })).toBeNull();
    expect(narrowNodesPool(null)).toBeNull();
  });
});
