import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { FleetLiveMap, LiveMapEdge, LiveMapNode } from '../../../../core/fleet/live-map.js';
import { fleetOrgGroups } from '../../../../core/fleet/org-groups.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { MapView } from './MapPane.js';
import { PhoneOrg } from './PhoneOrg.js';

const node = (kind: LiveMapNode['kind'], id: string, label: string, status: string, extra: Partial<LiveMapNode> = {}): LiveMapNode =>
  ({ id, kind, level: 0, label, provider: 'unknown', status, detail: 'detail', live: null, ...extra });
const reports = (from: string, to: string): LiveMapEdge =>
  ({ id: `reports-to:${from}->${to}`, kind: 'reports-to', from, to, messages: null, lastMessageAt: null, pulse: false });
const map = (nodes: LiveMapNode[], edges: LiveMapEdge[]): FleetLiveMap => ({ schema: 'fleet.live-map.v1', generatedAt: '2026-11-18T00:00:00Z',
  windowMinutes: 15, pulseSeconds: 60, nodes, edges, counts: { lanes: 0, jobs: 0, computers: 0, resources: 0, messages: null },
  sources: { org: 'available', jobs: 'available', computers: 'unknown', resources: 'available', messages: 'unknown' }, unmappedMessages: null, gaps: [] });

const busy = () => map([
  node('leader', 'leader', 'Leader', 'running'),
  node('lane', 'lane:claude', 'claude', 'running', { mergedPerHour: 9, health: { state: 'ok', reason: 'ok: 3 running, 1 ready', number: 3 } }),
  node('lane', 'lane:grok', 'grok', 'running', { mergedPerHour: 5, health: { state: 'held', reason: 'held: keeps 1 launch slot', number: 1 } }),
  node('job', 'job:RQ-ONE', 'RQ-ONE', 'running', { live: true }), node('job', 'job:RQ-TWO', 'RQ-TWO', 'running', { live: false }),
  node('job', 'job:RQ-THREE', 'RQ-THREE', 'queued'), node('job', 'job:RQ-FOUR', 'RQ-FOUR', 'running', { live: true }),
  node('resource', 'resource:claude', 'claude weekly quota', 'available', { usedPct: 42 }),
], [reports('lane:claude', 'leader'), reports('lane:grok', 'leader'), reports('job:RQ-ONE', 'lane:claude'), reports('job:RQ-TWO', 'lane:claude'),
  reports('job:RQ-THREE', 'lane:claude'), reports('job:RQ-FOUR', 'lane:grok')]);

let viewport: ViewportMock | null = null;
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe('PhoneOrg at 390 px', () => {
  it('busy fleet: headline, pinned asks, one row per lane, jobs on tap, log on tap', () => {
    viewport = mockViewport(390);
    const opened: string[] = [];
    const groups = fleetOrgGroups(busy());
    const { container } = render(<PhoneOrg groups={groups} asks={[{ id: 'a', text: 'Approve the release' }]} onOpenJob={id => opened.push(id)} />);
    expect(groups.headline).toMatchObject({ running: 3, queued: 1, stuck: 1, mergedLastHour: 14 });
    expect(screen.getByTestId('org-headline').textContent).toBe('3 running, 1 stuck, 14 merged in the last hour');
    // Asks card comes first, then the headline, then the lanes.
    const asks = screen.getByRole('region', { name: 'Needs you' }), headline = screen.getByTestId('org-headline'), rows = container.querySelector('ul')!.nextElementSibling ?? container.querySelectorAll('section > ul')[1]!;
    expect(asks.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(headline.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Approve the release')).toBeTruthy();
    const claude = screen.getByRole('button', { name: /claude/ });
    expect(claude.textContent).toContain('2 running, 1 queued');
    expect(within(claude).getByTestId('lane-health').textContent).toBe('ok');
    expect(within(claude).getByRole('meter').getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('grok').closest('button')!.textContent).toContain('Usage unknown');
    expect(claude.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('RQ-ONE')).toBeNull();
    fireEvent.click(claude);
    expect(claude.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('button', { name: /^Open log for/ }).map(b => b.textContent)).toEqual(
      ['RQ-ONErunning', 'RQ-TWOrunning · no activity for 5 min', 'RQ-THREEqueued']);
    fireEvent.click(screen.getByRole('button', { name: /^Open log for RQ-TWO/ }));
    expect(opened).toEqual(['RQ-TWO']);
    fireEvent.click(claude);
    expect(screen.queryByText('RQ-ONE')).toBeNull();
  });

  it('idle fleet says "Nothing running." and a lane with no usage reading says "Usage unknown"', () => {
    viewport = mockViewport(390);
    const idle = map([node('leader', 'leader', 'Leader', 'running'), node('lane', 'lane:zai', 'zai', 'idle')], [reports('lane:zai', 'leader')]);
    render(<PhoneOrg groups={fleetOrgGroups(idle)} onOpenJob={() => {}} />);
    expect(screen.getByTestId('org-headline').textContent).toBe('Nothing running.');
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    const lane = screen.getByRole('button', { name: /zai/ });
    expect(lane.textContent).toContain('Usage unknown');
    expect(lane.textContent).toContain('0 running, 0 queued');
    fireEvent.click(lane);
    expect(screen.getByText('No live jobs.')).toBeTruthy();
  });

  it('an unknown merge count reads "merged unknown", never 0', () => {
    const noMerges = busy();
    for (const row of noMerges.nodes) delete row.mergedPerHour;
    expect(fleetOrgGroups(noMerges).headline.text).toBe('3 running, 1 stuck, merged unknown');
  });

  it('MapView swaps the 2D tree for this layout on a phone and opens the job log', () => {
    viewport = mockViewport(390);
    const open = vi.fn();
    const { container } = render(<MapView map={busy()} now={0} onOpen={open} />);
    expect(container.querySelector('[data-org-group]')).toBeNull();
    expect(screen.getByRole('region', { name: 'Fleet org' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /claude/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Open log for RQ-ONE/ }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'job', label: 'RQ-ONE' }));
  });

  it('the full map is one tap away and one tap back', () => {
    viewport = mockViewport(390);
    render(<MapView map={busy()} now={0} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the full map' }));
    expect(screen.queryByRole('region', { name: 'Fleet org' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(screen.getByRole('region', { name: 'Fleet org' })).toBeTruthy();
  });

  it('cannot scroll sideways: no fixed widths, children may shrink, long names wrap', () => {
    viewport = mockViewport(390);
    const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/fleet-map/phone-org.module.css'), 'utf8');
    expect(css).not.toMatch(/(?<!max-|min-)width:\s*\d+px/);
    expect(css).not.toMatch(/white-space:\s*nowrap/);
    expect(css).toMatch(/min-width:\s*0/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/overflow-x:\s*hidden/);
    const { container } = render(<PhoneOrg groups={fleetOrgGroups(busy())} onOpenJob={() => {}} />);
    expect([...container.querySelectorAll<HTMLElement>('[style]')].every(el => /^width: \d+%;?$/.test(el.getAttribute('style')!))).toBe(true);
  });
});

describe('PhoneOrg recent messages', () => {
  const agent = (name: string, role: 'leader' | 'lane') => ({ name, role, lane: null, node: name });
  const edge = { id: 'leader->claude', from: agent('leader', 'leader'), to: agent('claude', 'lane'), count: 2,
    lastAt: '2026-11-18T00:00:00Z', lastSummary: 'start the docs job' };
  const now = Date.parse('2026-11-18T00:02:00Z');

  it('lists each recent message with its one-line summary', () => {
    render(<PhoneOrg groups={fleetOrgGroups(busy())} messages={[edge]} now={now} onOpenJob={() => {}} />);
    const list = within(screen.getByRole('region', { name: 'Recent messages' }));
    expect(list.getByText('leader → claude')).toBeTruthy();
    expect(list.getByText(/start the docs job/)).toBeTruthy();
  });
  it('says unknown when the bus could not be read, and nothing while loading', () => {
    const { rerender } = render(<PhoneOrg groups={fleetOrgGroups(busy())} messages={null} onOpenJob={() => {}} />);
    expect(screen.getByText('Messages unknown.')).toBeTruthy();
    rerender(<PhoneOrg groups={fleetOrgGroups(busy())} onOpenJob={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Recent messages' })).toBeNull();
  });
});
