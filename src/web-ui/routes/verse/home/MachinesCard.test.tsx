import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNodesPool, poolText } from '../../../../core/fleet/nodes-pool.js';
import type { NodeRow, NodesView } from '../../../../core/fleet/nodes-view.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { MachinesCard, narrowNodesPool } from './MachinesCard.js';
import { JOB_CHIPS, machinesSummary, macTiles } from './machines-card-model.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => vi.fn() }));

const GIB = 1024 ** 3, AT = '2026-11-17T12:00:00.000Z';
const row = (name: string, extra: Partial<NodeRow> = {}): NodeRow => ({ name, isSelf: false, reachable: true, lastSeen: AT, heartbeatAgeSeconds: 2, phantom: 'running',
  freeMemoryBytes: 12 * GIB, freeMemoryPercent: 37, load: 1.5, cpuHeadroomPercent: 80, lanes: ['claude'], jobsRunning: [], freeSlots: 2, stateCode: 'ready', state: 'ready for work', ...extra });
const view = (nodes: NodeRow[]): NodesView => ({ schema: 'phantom.nodes-view.v1', schemaVersion: 1, asOf: AT, self: 'alpha', registry: 'local', nodes, reasons: [] });
const pool = (nodes: NodeRow[]) => buildNodesPool(view(nodes), { selfOffload: true, disk: new Map([['alpha', 100 * GIB]]) });
const POOL = pool([
  row('alpha', { isSelf: true, jobsRunning: ['RQ-ONE'], freeSlots: 3 }),
  row('beta', { reachable: false, lastSeen: '2026-11-17T10:00:00.000Z', stateCode: 'offline', state: 'offline since 10:00', freeSlots: 0 }),
  row('gamma', { freeSlots: 'unknown', freeMemoryBytes: 'unknown', freeMemoryPercent: 'unknown', load: 'unknown', jobsRunning: 'unknown', stateCode: 'unknown' }),
]);
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390, status = 'success', onOpenJob?: (job: string) => void) => {
  viewport = mockViewport(width); state.read = { status, data }; return render(<MachinesCard onOpenJob={onOpenJob} />);
};
const macs = () => within(screen.getByRole('list', { name: 'Macs in the pool' })).getAllByRole('listitem');
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['390 px', 390], ['desktop width', 1440]])('Machines card at %s', (_name, width) => {
  it('shows the total, who answers, then a tile per Mac with this Mac first and no button', () => {
    show(POOL, width);
    const card = within(screen.getByRole('region', { name: 'Machines' }));
    expect(card.getByText('3 Macs, 3 free slots (1 not measured)')).toBeTruthy();
    expect(card.getByText('2 of 3 Macs online · 1 offline · 1 job running (1 Mac not reporting)')).toBeTruthy();
    expect(macs().map(item => item.textContent)).toEqual([
      'alpha(this Mac)onlineseen just now3free slotsMemory12.0 GB free, 63% in useRunningRQ-ONELoad1.5Disk free107.4 GBOffloadon',
      'betaofflineseen 2 h ago0free slotsMemory12.0 GB free, 63% in useRunningnothingLoad1.5Disk freeunknownOffloadunknown',
      'gammaonlineseen just nowfree slots unknownMemoryunknownRunningunknownLoadunknownDisk freeunknownOffloadunknown',
    ]);
    expect(macs()[1]!.getAttribute('data-status')).toBe('offline');
    expect(card.getByText('phm nodes pool --json')).toBeTruthy();
    expect(card.queryAllByRole('button')).toHaveLength(0);
  });
});

it('draws memory in use as a meter of the report\'s own share, and hatches a Mac with no share instead of an empty bar', () => {
  show(POOL);
  const meter = within(macs()[0]!).getByRole('meter', { name: 'alpha memory in use' });
  expect(meter.getAttribute('aria-valuenow')).toBe('63');
  expect(meter.getAttribute('aria-valuetext')).toBe('12.0 GB free, 63% in use');
  expect((meter.firstElementChild as HTMLElement).style.width).toBe('63%');
  const gamma = macs()[2]!;
  expect(within(gamma).queryByRole('meter')).toBeNull();
  expect(gamma.querySelector('[aria-hidden="true"][data-unknown]')).not.toBeNull();
  // An unmeasured slot count is words, never a 0.
  expect(within(gamma).getByText('free slots unknown').querySelector('strong')).toBeNull();
});

it('opens a running job\'s messages from its name when Home passes a way to, and leaves an id the server would refuse as text', () => {
  const onOpenJob = vi.fn();
  show(pool([row('alpha', { isSelf: true, jobsRunning: ['RQ-ONE', 'no'] })]), 1440, 'success', onOpenJob);
  const jobs = within(screen.getByRole('group', { name: 'Jobs running on alpha' }));
  fireEvent.click(jobs.getByRole('button', { name: 'Open messages for RQ-ONE' }));
  expect(onOpenJob).toHaveBeenCalledWith('RQ-ONE');
  expect(jobs.getAllByRole('button')).toHaveLength(1);
  expect(jobs.getByText('no').tagName).toBe('SPAN');
});

it(`names at most ${JOB_CHIPS} jobs on a tile and counts the rest`, () => {
  const jobs = Array.from({ length: JOB_CHIPS + 2 }, (_, n) => `RQ-JOB-${n}`);
  show(pool([row('alpha', { isSelf: true, jobsRunning: jobs })]), 1440, 'success', vi.fn());
  const group = within(screen.getByRole('group', { name: 'Jobs running on alpha' }));
  expect(group.getAllByRole('button')).toHaveLength(JOB_CHIPS);
  expect(group.getByText('+2 more')).toBeTruthy();
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
  expect(screen.queryByRole('list')).toBeNull();
});

describe('machines card model', () => {
  it('counts jobs only on Macs that report them, and says so when none does', () => {
    expect(machinesSummary(pool([row('alpha', { jobsRunning: ['RQ-ONE', 'RQ-TWO'] }), row('beta')]))).toBe('2 of 2 Macs online · 2 jobs running');
    expect(machinesSummary(pool([row('alpha', { jobsRunning: 'unknown', reachable: 'unknown' })]))).toBe('0 of 1 Mac online · 1 not known · running jobs unknown');
  });

  it('gives no bar when the report holds free memory but not its share, and refuses a share above 100', () => {
    const [bytesOnly, wild] = macTiles(pool([row('alpha', { freeMemoryPercent: 'unknown' }), row('beta', { freeMemoryPercent: 140 })]));
    expect(bytesOnly).toMatchObject({ memoryUsed: null, memoryWords: '12.0 GB free, share in use unknown' });
    expect(wild).toMatchObject({ memoryUsed: null, memoryWords: '12.0 GB free, share in use unknown' });
  });
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
