// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ClaimExecutionBody, ClaimExecutionCard } from './ClaimExecutionCard.js';
import { claimExecutionHeadline, parseClaimExecution } from './claim-execution-model.js';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const running = {
  claimId: 'claim-1', jobId: 'RQ-EXAMPLE-390', agent: 'worker-one', repo: 'ashlrai/phantom', state: 'RUNNING',
  worker: { pid: 123, lane: 'devin', tier: 'work', ageSeconds: 240 }, expiresInSeconds: 600,
};
const claimed = { ...running, claimId: 'claim-2', jobId: 'RQ-WAITING-390', state: 'CLAIMED_NO_WORKER', worker: null };
const payload = (overrides: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: new Date(NOW).toISOString(),
  report: {
    schema: 'fleet.claim-execution.v1', authority: 'none', asOf: new Date(NOW).toISOString(),
    ledger: 'known', processes: 'healthy', rows: [running, claimed],
    counts: { running: 99, claimedNoWorker: 0, unknown: 0 }, reasons: [], ...overrides,
  },
});

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('rejects malformed envelopes and reports', () => {
  for (const body of [null, undefined, [], 'bad', {}, { ...payload(), v: 2 }, { ...payload(), authority: 'write' }, payload({ schema: 'future' }), payload({ rows: null })]) {
    expect(parseClaimExecution(body)).toEqual({ kind: 'unavailable' });
  }
});

it('drops unknown states and counts only the retained rows', () => {
  const parsed = parseClaimExecution(payload({ rows: [null, { ...running, state: 'ASSIGNED' }, running, claimed] }));
  expect(parsed).toMatchObject({ kind: 'ok', rows: [{ state: 'RUNNING', worker: { pid: 123 } }, { state: 'CLAIMED_NO_WORKER', worker: null }], counts: { running: 1, claimedNoWorker: 1, unknown: 0 } });
});

it.each([undefined, null, 0, -1, 1.5, '123', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('downgrades RUNNING with invalid pid %s', pid => {
  const parsed = parseClaimExecution(payload({ rows: [{ ...running, worker: { ...running.worker, pid } }] }));
  expect(parsed).toMatchObject({ rows: [{ state: 'UNKNOWN', worker: null }], counts: { running: 0, unknown: 1 } });
  expect(claimExecutionHeadline(parsed).tone).toBe('unknown');
});

it('downgrades RUNNING without worker evidence', () => {
  expect(parseClaimExecution(payload({ rows: [{ ...running, worker: null }] }))).toMatchObject({ rows: [{ state: 'UNKNOWN' }] });
});

it('caps rows and reasons, and bounds reason text', () => {
  const parsed = parseClaimExecution(payload({
    rows: Array.from({ length: 30 }, (_, i) => ({ ...running, claimId: `claim-${i}` })),
    reasons: [null, '', ...Array.from({ length: 8 }, () => 'x'.repeat(500))],
  }));
  expect(parsed).toMatchObject({ counts: { running: 20, claimedNoWorker: 0, unknown: 0 } });
  if (parsed.kind !== 'ok') throw new Error('expected parsed report');
  expect(parsed.rows).toHaveLength(20);
  expect(parsed.reasons).toHaveLength(5);
  expect(parsed.reasons.every(r => r.length === 200)).toBe(true);
});

it.each(['ledger', 'processes'])('never calls unavailable %s empty or running', source => {
  for (const rows of [[], [running, claimed]]) {
    const parsed = parseClaimExecution(payload({ [source]: 'unavailable', rows, reasons: ['source unreadable'] }));
    expect(claimExecutionHeadline(parsed)).toEqual({ text: 'Claim execution unknown: source unreadable', tone: 'unknown' });
    if (parsed.kind !== 'ok') throw new Error('expected parsed report');
    expect(parsed.rows.every(row => row.state === 'UNKNOWN')).toBe(true);
    render(<ClaimExecutionBody parsed={parsed} now={NOW} />);
    expect(screen.queryByText('No live claims')).toBeNull();
    cleanup();
  }
});

it('reports headline counts and tones without trusting server counts', () => {
  expect(claimExecutionHeadline(parseClaimExecution(payload()))).toEqual({ text: '1 running, 1 claimed with no worker', tone: 'warn' });
  expect(claimExecutionHeadline(parseClaimExecution(payload({ rows: [running, running, claimed] })))).toEqual({ text: '2 running, 1 claimed with no worker', tone: 'warn' });
  expect(claimExecutionHeadline(parseClaimExecution(payload({ rows: [running] })))).toEqual({ text: '1 running', tone: 'ok' });
  expect(claimExecutionHeadline(parseClaimExecution(payload({ rows: [] })))).toEqual({ text: 'No live claims', tone: 'ok' });
  expect(claimExecutionHeadline(parseClaimExecution(null)).tone).toBe('unknown');
  expect(claimExecutionHeadline(parseClaimExecution(payload({ rows: [{ state: 'FUTURE' }] }))).tone).toBe('unknown');
});

it('renders running evidence, named claims, and claim expiry', () => {
  render(<ClaimExecutionBody parsed={parseClaimExecution(payload())} now={NOW + 60_000} />);
  expect(screen.getByText('Claim execution')).toBeTruthy();
  expect(screen.getByText('RUNNING')).toBeTruthy();
  expect(screen.getByText('RQ-EXAMPLE-390')).toBeTruthy();
  expect(screen.getByText('RQ-WAITING-390')).toBeTruthy();
  expect(screen.getAllByText('worker-one · ashlrai/phantom')).toHaveLength(2);
  expect(screen.getByText('pid 123 · devin · 4m old')).toBeTruthy();
  expect(screen.getByText('CLAIMED, no live worker')).toBeTruthy();
  expect(screen.getAllByText('expires in 9m')).toHaveLength(2);
  expect(screen.getByText('as of 1m old')).toBeTruthy();
});

it('renders missing identity and duration fields honestly', () => {
  render(<ClaimExecutionBody parsed={parseClaimExecution(payload({ rows: [{ state: 'UNKNOWN' }] }))} now={NOW} />);
  expect(screen.getByText('no job id')).toBeTruthy();
  expect(screen.getByText('expires in unknown')).toBeTruthy();
});

it('shows loading and then the missing-route message on 404', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new globalThis.Response('{}', { status: 404 })));
  render(<ClaimExecutionCard visible />);
  expect(screen.getByText('Reading claim execution…')).toBeTruthy();
  expect(await screen.findByText('The claim execution API has not landed in this build yet.')).toBeTruthy();
  expect(screen.queryByText('No live claims')).toBeNull();
});

it('shows unknown on network failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<ClaimExecutionCard visible />);
  expect(await screen.findByText('Claim execution unknown: read failed')).toBeTruthy();
});

it('does not fetch while the pane is hidden', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<ClaimExecutionCard visible={false} />);
  expect(fetch).not.toHaveBeenCalled();
});
