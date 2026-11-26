import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree, type FleetOrgTree } from '../../../../core/fleet/org-tree.js';
import type { FleetRunsDirState } from '../../../../core/fleet/runs-dir-state.js';
import type { ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import type { FleetSessionsV1 } from '../../../../core/fleet/runs-sessions.js';
import { listPanes } from '../panes/pane-registry.js';
import { buildPaletteItems, paletteView } from '../shell/palette-model.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { OrgTreeView } from './OrgTree.js';
import { buildLeaderSeat } from '../../../../core/fleet/leader-seat.js';
import './fleet-org.pane.js';

vi.mock('../fleet/JobDetailSheet.js', () => ({ JobDetailSheet: ({ job, repo, onClose }: { job: string; repo?: string | null; onClose: () => void }) =>
  <div role="dialog">{job} in {repo ?? 'unknown'}<button onClick={onClose}>Close</button></div> }));

const NOW = Date.parse('2026-11-17T12:00:00Z'), AT = '2026-11-17T12:00:00Z';
const session = (job: string, lane: string, extra: object = {}) => ({ job, lane, repo: 'phantom', model: 'fixture-model', status: 'running', tier: 'frontier',
  elapsedSeconds: 600, startedAt: '2026-11-17T11:50:00Z', live: 'yes', ...extra });
const lane = (name: string, running: number, target: number, extra: object = {}) => ({ lane: name, running, target, queued: 0, held: false, heldReason: null, ...extra });
/** The tree exactly as `phm org --json` prints it: built by the core builder, then sent as JSON. */
function tree(sessions: object[] | null, lanes: Array<{ lane: string }> | null, observedLanes = lanes?.map(row => row.lane)): FleetOrgTree {
  const map = fleetOrgMap(null, { now: NOW, observedLanes, sessions: sessions && { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions } as unknown as FleetSessionsV1 });
  return JSON.parse(JSON.stringify(fleetOrgTree(map, {
    runs: lanes && { lanes, events: [{ at: '2026-11-17T11:57:00Z', kind: 'LEADER', text: 'planned' }], lastTick: AT, paused: false, sources: { status: 'healthy', events: 'healthy' } } as unknown as FleetRunsDirState,
    usage: { asOf: AT, sources: { status: 'healthy' }, lanes: [{ lane: 'claude', usedPct: 41.6, resetAt: null }] } as unknown as ResourceLedgerV1,
  }))) as FleetOrgTree;
}
const busy = () => tree(
  [session('RQ-A', 'claude'), session('RQ-CLOUD', 'devin', { status: 'stale', live: 'no', published: true })],
  [lane('claude', 1, 8), lane('devin', 0, 0, { held: true, heldReason: 'autobackoff: usage limit' }), lane('gemini', 0, 1)]);
const head = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name},`) });

let viewport: ViewportMock | null = null;
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['desktop width', 1440], ['390 px', 390]])('Org tree at %s', (_name, width) => {
  it('draws leader, lanes and jobs, with held and idle lanes marked and folded', () => {
    viewport = mockViewport(width);
    const { container } = render(<OrgTreeView tree={busy()} now={NOW} />);
    const leader = screen.getByText('Leader (CEO)').parentElement!;
    expect(leader).toHaveTextContent('Running'); expect(leader).toHaveTextContent('Directing 1 running job across 1 lane');
    expect(leader).toHaveTextContent('model unknown · dispatcher last tick just now');
    // A running lane is open and shows its job; counts and pool use sit on the row itself.
    expect(head('claude')).toHaveAttribute('aria-expanded', 'true');
    expect(head('claude')).toHaveTextContent('Running'); expect(head('claude')).toHaveTextContent('1 of 8 running · pool 42% used');
    expect(head('claude').closest('li')!.querySelector('[data-provider-badge="Anthropic"]')).toBeTruthy();
    const job = screen.getByRole('button', { name: 'Open job RQ-A' });
    expect(job).toHaveTextContent('Running'); expect(job).toHaveTextContent('Working in phantom'); expect(job).toHaveTextContent('fixture-model · phantom · frontier · age 10m · started 10m ago');
    // Planners sit between the leader and the lanes, in a fixed order, each with its evidence or "unknown".
    const planners = within(screen.getByRole('list', { name: 'Planners' })).getAllByRole('listitem');
    expect(planners.map(row => row.querySelector('strong')!.textContent)).toEqual(['Executor', 'Core orchestrator', 'Main guardian', 'Comms']);
    expect(planners[0]).toHaveTextContent('Running'); expect(planners[0]).toHaveTextContent('Active · last sign 3m ago');
    expect(planners[1]).toHaveTextContent('Unknown: no sign in the recent dispatch log · last sign unknown');
    expect(planners[3]).toHaveAttribute('data-state', 'unknown');
    // Held and idle lanes are folded, labelled in words and marked for styling; the published cloud job is not counted as running.
    expect(head('devin')).toHaveAttribute('aria-expanded', 'false'); expect(head('devin')).toHaveTextContent('Held');
    expect(head('devin')).toHaveTextContent('0 of 0 running · pool use unknown');
    expect(head('devin').closest('li')).toHaveAttribute('data-state', 'held');
    // Grey lanes say why on the row, without opening them.
    expect(head('devin')).toHaveTextContent('Held: autobackoff: usage limit'); expect(head('gemini')).toHaveTextContent('Idle, nothing queued');
    expect(head('gemini')).toHaveTextContent('Idle'); expect(head('gemini').closest('li')).toHaveAttribute('data-state', 'idle');
    expect(screen.queryByRole('button', { name: 'Open job RQ-CLOUD' })).toBeNull();
    // One column of rows at every width: no table and no sideways layout to break on a phone.
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(2);
  });

  it('expands a lane, shows a published job as done and opens the existing job detail in one click', () => {
    viewport = mockViewport(width);
    render(<OrgTreeView tree={busy()} now={NOW} />);
    fireEvent.click(head('devin'));
    expect(head('devin')).toHaveAttribute('aria-expanded', 'true');
    expect(head('devin').closest('li')).toHaveTextContent('Held: autobackoff: usage limit · fixture-model');
    const done = screen.getByRole('button', { name: 'Open job RQ-CLOUD' });
    expect(done).toHaveTextContent('Done'); expect(done).toHaveTextContent('Published its result; waiting for cleanup');
    fireEvent.click(done);
    expect(screen.getByRole('dialog')).toHaveTextContent('RQ-CLOUD in phantom');
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(head('claude')); expect(screen.queryByRole('button', { name: 'Open job RQ-A' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(within(head('gemini').closest('li')!).getByText('No jobs.')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Open job RQ-A' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' })); expect(screen.queryByRole('button', { name: /Open job/ })).toBeNull();
  });
});

it('shows an empty fleet as idle and an unread fleet as unknown, never as zero', () => {
  render(<OrgTreeView tree={tree([], [lane('claude', 0, 8)])} now={NOW} />);
  expect(screen.getByText('No jobs running')).toBeTruthy(); expect(head('claude')).toHaveTextContent('Idle'); expect(head('claude')).toHaveTextContent('0 of 8 running');
  cleanup();
  render(<OrgTreeView tree={tree(null, null, ['grok'])} now={NOW} />);
  expect(screen.getByText('Leader (CEO)').parentElement).toHaveTextContent('Unknown');
  expect(head('grok')).toHaveTextContent('Unknown'); expect(head('grok')).toHaveTextContent('unknown of unknown running · pool use unknown');
  fireEvent.click(head('grok')); expect(head('grok').closest('li')).toHaveTextContent('Jobs unknown.');
});

it('shows the typed Leader seat report with fallback health, headroom and unknown evidence', () => {
  const value = busy(); value.leaderSeat = buildLeaderSeat(null, null, null, NOW);
  value.leaderSeat.current = { lane: 'claude', model: 'fixture-model', lastSuccessAt: AT };
  value.leaderSeat.fallbacks = [{ lane: 'codex-personal', model: 'fixture-b', confirmed: true, cli: 'codex', health: 'ok', headroomPct: 72,
    resetAt: null, recentPassMs: null, rateLimitedAt: null, eligible: true, reason: null }];
  value.leaderSeat.pick = value.leaderSeat.fallbacks[0]!;
  render(<OrgTreeView tree={value} now={NOW} />);
  const row = screen.getByLabelText('Leader seat');
  expect(row).toHaveTextContent('claude · fixture-model'); expect(row).toHaveTextContent('Last successful pass just now');
  expect(row).toHaveTextContent('Next seat: codex-personal · fixture-b'); expect(row).toHaveTextContent('ok · 72% left');
  cleanup(); render(<OrgTreeView tree={busy()} now={NOW} />);
  expect(screen.getByLabelText('Leader seat')).toHaveTextContent('unknown · model unknown');
  expect(screen.getByLabelText('Leader seat')).toHaveTextContent('No seat: lane health is unknown.');
});

it('is listed in the Cmd+K palette from the pane registry', () => {
  const items = buildPaletteItems({ panes: listPanes(), needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' });
  const item = items.find(candidate => candidate.key === 'pane:fleet-org');
  expect(item).toMatchObject({ title: 'Open pane: Org', payload: { kind: 'pane', paneId: 'fleet-org' } });
  for (const query of ['org', 'org structure', 'lane']) expect(paletteView(items, query, [], 'mac').flat.some(candidate => candidate.key === 'pane:fleet-org'), query).toBe(true);
});
