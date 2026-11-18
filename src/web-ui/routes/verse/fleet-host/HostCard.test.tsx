import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { HostReportV1 } from '../../../../core/fleet/host-top.js';
import { evictAll } from '../../../data/cache.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { HostCard } from './HostCard.js';
import { HOST_TOP_PATH, narrowHostTop } from './host-top-query.js';
import styles from './fleet-host.module.css';

const GB = 1024 ** 3;
const report = (over: Partial<HostReportV1> = {}): HostReportV1 => ({
  schema: 'phantom.host.v1', version: 1, generatedAt: '2026-11-17T20:00:00.000Z',
  load: { load1: 165.2, load5: 150, load15: 120, cpuCount: 18 }, memory: { freePercent: 9.5, swapGb: 4.25 },
  processes: { state: 'known', reason: null, count: 900, cwd: 'unavailable', cpuPercent: 1600, fleetCpuPercent: 200, otherCpuPercent: 1400, fleetShare: 0.125 },
  topCpu: [
    { family: 'spotlight', label: 'Spotlight', fleet: false, processes: 12, cpuPercent: 900, rssBytes: 1.5 * GB },
    { family: 'node', label: 'Node/Bun/tsx', fleet: true, processes: 1, cpuPercent: 200, rssBytes: 0.5 * GB },
  ],
  topRss: [],
  orphans: [{ pid: 4242, family: 'node', name: 'node', job: 'RQ-GONE', reason: 'worktree-gone', ageSeconds: 11_520 }], orphanCount: 1,
  ...over,
});

let viewport: ViewportMock | null = null;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));

describe.each([['desktop width', 1440], ['390 px', 390]])('Host card at %s', (_name, width) => {
  beforeEach(() => { viewport = mockViewport(width); });

  it('shows load, memory, fleet share, busiest groups and orphans in plain words', async () => {
    serve(report());
    render(<HostCard visible />);
    const card = await screen.findByRole('region', { name: 'Host' });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toContain(HOST_TOP_PATH);
    expect(within(card).getByText('Load 165.2 on 18 CPUs')).toHaveAttribute('data-tone', 'bad');
    expect(within(card).getByText('Memory 9.5% free · swap 4.25 GB')).toBeInTheDocument();
    expect(within(card).getByText('Fleet 2.0 cores (13%) · not fleet 14.0 cores')).toBeInTheDocument();
    const busiest = within(within(card).getByRole('list', { name: 'Busiest' })).getAllByRole('listitem');
    expect(busiest.map(li => li.textContent)).toEqual([
      'Spotlight · not fleet · 9.0 cores · 1.5 GB · 12 processes', 'Node/Bun/tsx · fleet · 2.0 cores · 0.5 GB · 1 process']);
    expect(busiest[0]).toHaveAttribute('data-tone', 'warn');
    expect(within(card).getByText('RQ-GONE · node pid 4242 · worktree gone · 3h 12m')).toBeInTheDocument();
    // Rows are wrapping text lines, so long labels fold inside a 390 px column instead of overflowing.
    for (const li of busiest) expect(li).toHaveClass(styles.line!);
  });

  it('says unknown when ps is denied instead of showing zeros', async () => {
    serve(report({ memory: { freePercent: null, swapGb: null }, processes: { state: 'unknown', reason: 'ps-denied', count: null, cwd: 'unavailable',
      cpuPercent: null, fleetCpuPercent: null, otherCpuPercent: null, fleetShare: null }, topCpu: null, topRss: null, orphans: null, orphanCount: null }));
    render(<HostCard visible />);
    const card = await screen.findByRole('region', { name: 'Host' });
    expect(within(card).getByText('Processes unknown: ps is not permitted here')).toBeInTheDocument();
    expect(within(card).getByText('Memory unknown free · swap unknown')).toBeInTheDocument();
    expect(within(card).queryByRole('list')).toBeNull();
    expect(card.textContent).not.toMatch(/\b0\.0 cores/);
  });
});

it('renders nothing when the route is absent or the schema is wrong', async () => {
  serve({}, 404);
  const { container } = render(<HostCard visible />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  expect(narrowHostTop({ ...report(), version: 2 })).toBeNull();
  expect(narrowHostTop({ ...report(), topCpu: [{ label: 'x' }] })).toBeNull();
  expect(narrowHostTop(report())).not.toBeNull();
});
