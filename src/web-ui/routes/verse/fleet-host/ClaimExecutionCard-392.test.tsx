import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ClaimExecutionBody, ClaimExecutionCard } from './ClaimExecutionCard.js';
import { parseClaimExecution } from './claim-execution-model.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const report = (rows: unknown[], reasons: string[] = []) => ({
  v: 1, authority: 'none', report: {
    schema: 'fleet.claim-execution.v1', authority: 'none', asOf: '2026-11-14T12:00:00Z',
    ledger: 'known', processes: 'healthy', rows, reasons,
  },
});
const row = (overrides: Record<string, unknown> = {}) => ({
  claimId: 'fake-claim', jobId: 'fake-job', agent: 'fake-agent', repo: 'fake-repo',
  state: 'RUNNING', worker: { pid: 12345, lane: 'fake-lane', ageSeconds: 180 }, expiresInSeconds: 600,
  ...overrides,
});

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows the matched worker details for a running claim', () => {
  render(<ClaimExecutionBody parsed={parseClaimExecution(report([row()]))} now={NOW} />);
  expect(screen.getByText('RUNNING')).toBeTruthy();
  expect(screen.getByText('pid 12345 · fake-lane · 3m old')).toBeTruthy();
});

it('shows a claimed row without a live worker or pid', () => {
  render(<ClaimExecutionBody parsed={parseClaimExecution(report([row({ state: 'CLAIMED_NO_WORKER' })]))} now={NOW} />);
  const claim = screen.getByText('CLAIMED, no live worker').closest('li');
  expect(claim).toBeTruthy();
  expect(within(claim!).queryByText(/pid/i)).toBeNull();
});

it('shows a fallback when a row has no job id', () => {
  render(<ClaimExecutionBody parsed={parseClaimExecution(report([row({ jobId: null })]))} now={NOW} />);
  expect(screen.getByText('no job id')).toBeTruthy();
});

it('renders reasons as list items', () => {
  render(<ClaimExecutionBody parsed={parseClaimExecution(report([], ['fake reason one', 'fake reason two']))} now={NOW} />);
  const first = screen.getByText('fake reason one', { selector: 'li' });
  const second = screen.getByText('fake reason two', { selector: 'li' });
  expect(first.parentElement?.tagName).toBe('UL');
  expect(second.parentElement).toBe(first.parentElement);
});

it('shows a read failure when the query errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<ClaimExecutionCard visible />);
  expect(await screen.findByText('Claim execution unknown: read failed')).toBeTruthy();
});

it('shows the not-landed message when the query returns null', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<ClaimExecutionCard visible />);
  expect(await screen.findByText(/has not landed in this build yet/)).toBeTruthy();
});
