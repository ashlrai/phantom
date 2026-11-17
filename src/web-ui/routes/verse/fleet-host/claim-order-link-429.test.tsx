import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ClaimExecutionBody, ClaimExecutionCard } from './ClaimExecutionCard.js';
import { parseClaimExecution } from './claim-execution-model.js';
import { linkClaimsToOrders } from './claim-order-link.js';
import { parseOrderStateBody } from '../fleet-board/order-state-model.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const report = (rows: unknown[]) => ({
  v: 1, authority: 'none', report: {
    schema: 'fleet.claim-execution.v1', authority: 'none', asOf: '2026-11-14T12:00:00Z',
    ledger: 'known', processes: 'healthy', rows, reasons: [],
  },
});
const claim = (o: Record<string, unknown> = {}) => ({
  claimId: 'fake-claim', jobId: 'RQ-PHX-ABCD', agent: 'fake-agent', repo: 'fake-repo',
  state: 'RUNNING', worker: { pid: 12345, lane: 'fake-lane', ageSeconds: 180 }, expiresInSeconds: 600, ...o,
});
const order = (o: Record<string, unknown> = {}) => ({
  at: '2026-11-13T18:13:00Z', source: 'slack', key: 'fake-order-1', state: 'RUNNING', asOf: '2026-11-13T18:20:00Z',
  evidenceSource: 'fake', missing: [], pr: null, owner: { job: 'RQ-PHX-ABCD', lane: 'fake-lane' }, ...o,
});
const orders = (rows: unknown[]) => ({ v: 1, asOf: '2026-11-13T18:20:00Z', sources: {}, orders: rows });
const link = (claims: unknown[], rows: unknown[]) =>
  linkClaimsToOrders(parseClaimExecution(report(claims)), parseOrderStateBody(orders(rows)));

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('links an exact jobId match and renders the order', () => {
  const parsed = parseClaimExecution(report([claim()]));
  const links = linkClaimsToOrders(parsed, parseOrderStateBody(orders([order()])));
  expect(links.get('fake-claim')?.orderKey).toBe('fake-order-1');
  render(<ClaimExecutionBody parsed={parsed} now={NOW} orderLinks={links} />);
  expect(screen.getByText(/serves slack order \d\d:\d\d \(RUNNING on board\)/)).toBeTruthy();
});

it('does not link a shortened job id by prefix', () => {
  expect(link([claim({ jobId: 'RQ-PHX-ABC' })], [order()]).size).toBe(0);
});

it('does not link an UNKNOWN claim', () => {
  expect(link([claim({ state: 'UNKNOWN' })], [order()]).size).toBe(0);
});

it('does not link a claim without a job id', () => {
  expect(link([claim({ jobId: null })], [order()]).size).toBe(0);
});

it('links the newest order when two name the same job', () => {
  const links = link([claim()], [
    order({ key: 'older', at: '2026-11-13T17:00:00Z' }),
    order({ key: 'newer', at: '2026-11-13T19:00:00Z' }),
    order({ key: 'oldest', at: '2026-11-13T16:00:00Z' }),
  ]);
  expect(links.get('fake-claim')?.orderKey).toBe('newer');
});

it('returns an empty map for unavailable inputs', () => {
  expect(linkClaimsToOrders({ kind: 'unavailable' }, parseOrderStateBody(orders([order()]))).size).toBe(0);
  expect(linkClaimsToOrders(parseClaimExecution(report([claim()])), { kind: 'unavailable' }).size).toBe(0);
  expect(linkClaimsToOrders(parseClaimExecution(report([claim()])), undefined).size).toBe(0);
});

it('flags a RUNNING claim whose order is still ASSIGNED', () => {
  const parsed = parseClaimExecution(report([claim()]));
  const links = linkClaimsToOrders(parsed, parseOrderStateBody(orders([order({ state: 'ASSIGNED' })])));
  render(<ClaimExecutionBody parsed={parsed} now={NOW} orderLinks={links} />);
  expect(screen.getByText(/serves slack order/).getAttribute('data-mismatch')).toBe('true');
});

it('does not flag a RUNNING claim whose order is RUNNING', () => {
  const parsed = parseClaimExecution(report([claim()]));
  const links = linkClaimsToOrders(parsed, parseOrderStateBody(orders([order()])));
  render(<ClaimExecutionBody parsed={parsed} now={NOW} orderLinks={links} />);
  expect(screen.getByText(/serves slack order/).hasAttribute('data-mismatch')).toBe(false);
});

const mockFetch = (ordersRes: () => Response) => vi.stubGlobal('fetch', vi.fn(async (url: string) =>
  String(url).includes('claim-execution') ? new Response(JSON.stringify(report([claim()])), { status: 200 }) : ordersRes()));

it('renders the card with a link when both reads succeed', async () => {
  mockFetch(() => new Response(JSON.stringify(orders([order()])), { status: 200 }));
  render(<ClaimExecutionCard visible />);
  expect(await screen.findByText(/serves slack order/)).toBeTruthy();
});

it('renders the card as before when the orders endpoint 404s', async () => {
  mockFetch(() => new Response('{}', { status: 404 }));
  render(<ClaimExecutionCard visible />);
  expect(await screen.findByText('RUNNING')).toBeTruthy();
  expect(screen.queryByText(/serves/)).toBeNull();
});

it('renders the card as before when the orders body is garbage', async () => {
  mockFetch(() => new Response('not json', { status: 200 }));
  render(<ClaimExecutionCard visible />);
  expect(await screen.findByText('RUNNING')).toBeTruthy();
  expect(screen.queryByText(/serves/)).toBeNull();
});
