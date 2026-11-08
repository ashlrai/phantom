import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet, ApiError } from '../../../data/client.js';
import { JobDetailSheet } from './JobDetailSheet.js';

vi.mock('../../../data/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(),
}));

const job = 'RQ-COST-UI';
const detail = { schema: 'fleet.job.v1', job, state: 'running', lane: 'claude',
  log: { source: 'live', tail: ['Log line'] },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
const cost = {
  schema: 'fleet.job.cost.v1', generatedAt: '2026-11-02T12:00:00Z', job,
  calls: [
    { at: '2026-11-02T08:00:00Z', model: 'claude-test-a', lane: 'claude', inputTokens: 12000, outputTokens: 1900, costUsd: 0.21, estimated: false, error: false },
    { at: '2026-11-02T09:00:00Z', model: 'claude-test-b', lane: 'claude', inputTokens: 480, outputTokens: 36, costUsd: null, estimated: true, error: false },
  ],
  totals: { calls: 2, errors: 0, inputTokens: 12480, outputTokens: 1936, costUsd: 0.21, reported: { inputTokens: 2, outputTokens: 2, costUsd: 1 } },
  jobTotals: { finishes: 1, tokensTotal: 182000 },
  sources: { apiSpend: 'healthy', jobs: 'healthy' },
  truncated: false,
};

beforeEach(() => {
  evictAll();
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path.startsWith('/api/fleet/job/cost?')) return cost;
    if (path.startsWith('/api/fleet/job/changes?')) return { schema: 'fleet.job.changes.v1', generatedAt: '2026-11-02T12:00:00Z', job, state: 'missing', baseSha: null, files: [], totals: { files: 0, added: 0, removed: 0 }, truncated: false };
    if (path.startsWith('/api/fleet/job/text?')) return { v: 1, job, kind: 'notes', state: 'missing', source: null, bytes: null, truncated: false, text: '' };
    return detail;
  });
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); evictAll(); });

it('shows the per-call cost breakdown with real numbers and unknowns', async () => {
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Cost' });
  expect(await within(section).findByText('Cost · 2 calls · 12,480 in / 1,936 out · $0.2100 across 1 of 2 calls')).toBeInTheDocument();
  const rows = within(section).getAllByRole('listitem').map(row => row.textContent ?? '');
  expect(rows[0]).toContain('claude-test-a');
  expect(rows[0]).toContain('12,000→1,900');
  expect(rows[0]).toContain('$0.2100');
  expect(rows[1]).toContain('claude-test-b');
  expect(rows[1]).toContain('unknown (est.)');
  expect(within(section).getByText(/Worker-reported tokens_total 182,000 across 1 finish event/)).toBeInTheDocument();
});

it('reports when the cost route is not in this build', async () => {
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path.startsWith('/api/fleet/job/cost?')) throw new ApiError('Not found', 404, path);
    return detail;
  });
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Cost is not in this build yet')).toBeInTheDocument();
});

it('says no recorded calls when the ledger has none for the job', async () => {
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path.startsWith('/api/fleet/job/cost?')) return { ...cost, calls: [], totals: { calls: 0, errors: 0, inputTokens: null, outputTokens: null, costUsd: null, reported: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }, jobTotals: { finishes: 0, tokensTotal: null } };
    return detail;
  });
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Cost' });
  expect(await within(section).findByText('No recorded model calls.')).toBeInTheDocument();
  expect(within(section).getByText('Cost · 0 calls · unknown in / unknown out · unknown')).toBeInTheDocument();
});

it('surfaces a read failure without breaking the sheet', async () => {
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path.startsWith('/api/fleet/job/cost?')) throw new Error('offline');
    return detail;
  });
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Cost unavailable')).toBeInTheDocument();
  expect(screen.getByText('Log line')).toBeInTheDocument();
});
