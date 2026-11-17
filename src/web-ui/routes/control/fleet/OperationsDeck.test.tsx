import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { OperationsDeck } from './OperationsDeck.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';

vi.mock('../../../data/hooks.js', () => ({ useQuery: vi.fn(), useRefetch: vi.fn() }));
const at = new Date().toISOString();
let compute: unknown;
let live: unknown;
let failed = false;
let daemonAt = at;
beforeEach(() => {
  failed = false;
  daemonAt = at;
  compute = { generatedAt: at, dispatcherAt: at, operations: { publishes24h: 17,
    admission: { admit: false, gateReason: 'worktrees', warnings: ['daemon-stale'], observedAt: at } } };
  live = { generatedAt: at, state: 'running', blockedHolds: [], commit: 'abc123',
    lanes: [{ lane: 'claude' }], runs: [{ id: 'job', lane: 'claude', repo: 'phantom',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(), phaseStartedAt: new Date(Date.now() - 3_600_000).toISOString(),
      phase: 'producing', endedAt: null, outcome: null, prNumber: null }] };
  vi.mocked(useRefetch).mockReturnValue(vi.fn());
  vi.mocked(useQuery).mockImplementation(query => ({ status: failed ? 'error' : 'success', data:
    query.key === 'fleet' ? { daemon: { lastTickAt: daemonAt } } : query.key === 'fleet-operations-compute' ? compute : query.key.startsWith('queue-stats') ? { generatedAt: Date.now(), stations: [{ station: 'merge-queue', currentQueueLength: 4 }] }
      : query.key === 'fleet-lanes' ? { lanes: [{ lane: 'claude', queueDepth: 3 }] } : { value: live },
  }) as never);
});
afterEach(() => vi.useRealTimers());

describe('OperationsDeck', () => {
  it('renders measured fields, health, stuck phase and evidence pointers', () => {
    render(<OperationsDeck />);
    expect(screen.getByText('17').parentElement).toHaveAttribute('title', expect.stringContaining('publishes_24h'));
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('held')).toBeInTheDocument();
    expect(screen.getByText(/1 call · unknown errors · unknown p50 · commit abc123/)).toBeInTheDocument();
    expect(screen.getByText(/stuck · producing/)).toBeInTheDocument();
    expect(screen.getByText('3')).toHaveAttribute('title', expect.stringContaining('/api/fleet/lanes'));
    expect(screen.getAllByText(/admission.admit/).length).toBeGreaterThan(0);
  });
  it('shows launch vitals from the shared compute projection', () => {
    compute = { ...(compute as object), launchVitals: { reason: null, nextWindowSeconds: null, queued: 3, lanes: [{ lane: 'claude', running: 1, target: 8, queued: 3 }] } };
    render(<OperationsDeck />);
    const section = screen.getByRole('region', { name: "Why isn't it launching" });
    expect(within(section).getByText(/Reason unknown.*Next launch window: unknown.*Queued: 3/)).toBeInTheDocument();
    expect(within(section).getByText('claude: 1 running of 8 target; 3 queued')).toBeInTheDocument();
  });
  it('caps needs-you at five, including stale ticks, warnings and held PR evidence', () => {
    compute = { dispatcherAt: '2020-01-01T00:00:00Z', operations: { admission: { admit: true, warnings: ['capacity warning'] } } };
    live = { ...(live as object), runs: Array.from({ length: 8 }, (_, i) => ({ id: `held-${i}`, repo: 'phantom', outcome: 'owner-lane', prNumber: i + 1 })) };
    render(<OperationsDeck />);
    const strip = screen.getByRole('region', { name: 'Needs you' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(5);
    expect(within(strip).getByText(/Dispatcher tick/)).toBeInTheDocument();
    expect(within(strip).getByText(/#1 held for owner lane/)).toBeInTheDocument();
    expect(within(strip).getByText(/runs\[held-0\]/)).toBeInTheDocument();
  });
  it('surfaces stale daemon evidence separately from dispatcher evidence', () => {
    daemonAt = '2020-01-01T00:00:00Z';
    render(<OperationsDeck />);
    expect(screen.getByText(/Daemon tick/)).toBeInTheDocument();
    expect(screen.getByText('/api/fleet · daemon.lastTickAt')).toBeInTheDocument();
  });
  it('shows unknowns for empty API data', () => {
    compute = {}; live = null;
    render(<OperationsDeck />);
    expect(screen.getByText('Needs-you evidence unknown or incomplete.')).toBeInTheDocument();
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(3);
  });
  it('withholds cached admission and counts after failed refreshes', () => {
    failed = true;
    render(<OperationsDeck />);
    expect(screen.queryByText('17')).not.toBeInTheDocument();
    expect(screen.queryByText('held')).not.toBeInTheDocument();
    expect(screen.getByText('Lane evidence unknown or empty.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Compute: unavailable');
  });
});
