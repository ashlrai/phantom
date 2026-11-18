import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrgMap } from './OrgMap.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import { fleetOrgMap, type FleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree } from '../../../../core/fleet/org-tree.js';
import type { FleetRunsDirState } from '../../../../core/fleet/runs-dir-state.js';
import type { ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import type { FleetSessionsV1 } from '../../../../core/fleet/runs-sessions.js';

const read = vi.hoisted(() => ({ data: undefined as FleetOrgMap | undefined, status: 'loading' }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => read, useRefetch: () => () => {} }));
vi.mock('./JobDetailSheet.js', () => ({ JobDetailSheet: ({ job, repo, onClose }: { job: string; repo?: string | null; onClose: () => void }) => <div role="dialog">{job} in {repo ?? 'unknown'}<button onClick={onClose}>Close</button></div> }));
afterEach(() => { cleanup(); read.data = undefined; read.status = 'loading'; });

const NOW = Date.parse('2026-11-16T12:00:00Z'), AT = '2026-11-16T12:00:00Z';
/** What the server sends: the graph plus its tree, built by the same functions. */
function fixture(): FleetOrgMap {
  const sessions = { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: [
    { job: 'J1', lane: 'claude', repo: 'phantom', model: 'claude-fable-5-2', status: 'running', elapsedSeconds: 120, startedAt: '2026-11-16T11:58:00Z', live: 'yes' },
    { job: 'J2', lane: 'claude', repo: null, model: null, status: 'stale', elapsedSeconds: 7200, startedAt: '2026-11-16T10:00:00Z', live: 'no' },
    { job: 'J3', lane: 'mystery-lane', repo: null, model: null, status: 'launching', elapsedSeconds: null, startedAt: null, live: 'unknown' },
  ] } as unknown as FleetSessionsV1;
  const messages = { schema: 'fleet.edges.v1' as const, source: 'available' as const,
    edges: [{ from: { address: 'claude', provider: null }, to: { address: 'leader', provider: null }, messages: 2, messagesLastHour: 2, lastAt: NOW }] };
  const map = fleetOrgMap(null, { sessions, messages, minutes: 15, now: NOW });
  const runs = { lastTick: '2026-11-16T11:59:00Z', paused: false, events: [], sources: { status: 'healthy' },
    lanes: [{ lane: 'claude', running: 2, target: 8, queued: 3, held: false }, { lane: 'gemini', running: 0, target: 1, queued: 0, held: false }] } as unknown as FleetRunsDirState;
  const usage = { asOf: '2026-11-16T11:00:00Z', sources: { status: 'healthy' }, lanes: [{ lane: 'claude', usedPct: 42, resetAt: null }] } as unknown as ResourceLedgerV1;
  return { ...map, tree: fleetOrgTree(map, { runs, usage }) };
}
const lane = (name: string) => screen.getByRole('region', { name });

describe('Fleet map', () => {
  it('shows the empty state as unknown, never as idle or zero', () => {
    render(<OrgMap live={null} now={NOW} />);
    expect(screen.getByText('Fleet state unknown.')).toBeTruthy();
    expect(screen.getByText('Leader (CEO)').parentElement).toHaveTextContent('Status unknown');
    expect(screen.getByText('Leader (CEO)').parentElement).toHaveTextContent('Dispatcher state unknown, last tick unknown');
    expect(lane('claude')).toHaveTextContent('unknown running of unknown, unknown queued');
    expect(lane('claude')).toHaveTextContent('usage unknown');
    expect(lane('claude')).toHaveTextContent('jobs unknown');
    expect(screen.queryByText('idle')).toBeNull(); expect(screen.queryByRole('button', { name: /Open job/ })).toBeNull();
    expect(screen.getByText('Agent messages unknown.')).toBeTruthy();
  });
  it('shows snapshot jobs below their lane while the full map loads', () => {
    const live = { generatedAt: 'now', state: 'running', lanes: [{ lane: 'codex', slots: 2, busy: 1, capReason: null }],
      runs: [{ id: 'J1', title: 'Fix a bug', repo: 'phantom', lane: 'codex', phase: 'producing', endedAt: null, outcome: null }] } as FleetLiveSnapshotV1;
    render(<OrgMap live={live} now={NOW} />);
    expect(within(lane('codex')).getByRole('button', { name: 'Open job J1' })).toHaveTextContent('phantom');
    expect(lane('codex')).toHaveTextContent('1 running of 2, unknown queued');
    expect(lane('claude')).toHaveTextContent('idle');
  });
  it('draws a card per lane with its logo, counts, usage, job chips and live dots', () => {
    read.data = fixture(); read.status = 'success';
    render(<OrgMap live={null} now={NOW} />);
    const claude = lane('claude');
    expect(claude.querySelector('h3 [data-provider-badge="Anthropic"] svg[aria-label="Anthropic"]')).toBeTruthy();
    expect(claude).toHaveTextContent('2 running of 8, 3 queued'); expect(claude).toHaveTextContent('usage 42% (measured 1h ago)');
    expect(claude.querySelector('h3 [data-live]')).toHaveAttribute('data-live', 'true');
    const [stale, fresh] = within(claude).getAllByRole('button');
    expect(fresh).toHaveAccessibleName('Open job J1'); expect(fresh).toHaveTextContent('claude-fable-5-2 · phantom');
    expect(fresh).toHaveTextContent('running · started 2m ago · last event started 2m ago');
    expect(within(fresh).getByRole('img', { name: 'Active in the last 5 minutes' })).toHaveAttribute('data-live', 'true');
    expect(stale).toHaveTextContent('model unknown · repo unknown'); expect(stale).toHaveTextContent('stale · started 2h ago');
    expect(within(stale).getByRole('img', { name: 'Quiet for over 5 minutes' })).toHaveAttribute('data-live', 'false');
    // An unrecognised lane gets the neutral "?" mark and an unknown dot, not a guessed logo or a zero.
    const mystery = lane('mystery-lane');
    expect(mystery.querySelector('h3 [data-provider-badge="unknown"] svg')).toHaveTextContent('?');
    expect(mystery).toHaveTextContent('unknown running of unknown'); expect(mystery).toHaveTextContent('started unknown · last event unknown');
    expect(within(mystery).getAllByRole('img', { name: 'Activity unknown' })).toHaveLength(2);
    expect(lane('gemini')).toHaveTextContent('0 running of 1, 0 queued'); expect(within(lane('gemini')).getByText('idle')).toBeTruthy();
    expect(lane('gemini').querySelector('[data-live]')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Messages in the last 15 minutes' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent messages' })).toHaveTextContent('claude Leader (CEO): 2 messages');
  });
  it('opens the existing job detail in one click', () => {
    read.data = fixture(); read.status = 'success';
    render(<OrgMap live={null} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open job J1' })); expect(screen.getByRole('dialog')).toHaveTextContent('J1 in phantom');
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('lets a live dot expire when the data stops refreshing', () => {
    read.data = fixture(); read.status = 'error';
    render(<OrgMap live={null} now={NOW + 6 * 60_000} />);
    expect(screen.getByRole('status')).toHaveTextContent('may be stale');
    expect(lane('claude').querySelector('h3 [data-live]')).toHaveAttribute('data-live', 'false');
    read.data.tree = undefined; read.data.sources.messages = 'unavailable'; cleanup();
    render(<OrgMap live={null} now={NOW} />);
    expect(screen.getByText('Agent messages unknown.')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Open job J1' })).toBeTruthy();
  });
});
