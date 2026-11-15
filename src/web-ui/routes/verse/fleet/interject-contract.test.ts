import { expect, it } from 'vitest';
import type { OrderTraceJob, OrderTraceV1 } from '../fleet-inbox/order-trace-model.js';
import { interjectOutcome } from './interject-outcome-model.js';

const NOW = '2026-11-13T12:00:00.000Z';
const AT = '2026-11-01 00:08 ET';
const GEN = '2026-11-13T11:59:00Z';
const PR = 'https://github.com/ashlrai/phantom/pull/77';

const trace = (...jobs: OrderTraceJob[]): OrderTraceV1 => ({
  v: 1, generatedAt: GEN, sources: { inbox: null, prompts: null, publishes: null },
  orders: [{ at: AT, source: 'Phantom desktop', key: '11-01 00:08', jobs }],
});
const job = (state: OrderTraceJob['state'], lane: string | null = 'claude', url: string | null = null): OrderTraceJob =>
  ({ id: 'RQ-PHX-FAKE01', lane, state, url });
const contract = (t: OrderTraceV1 | null, acked = false, at = AT) => interjectOutcome(at, acked, t, NOW).contract;

it('no job is RECEIVED, acked or not, and keeps the old stage and text', () => {
  expect(contract(null, true).state).toBe('RECEIVED');
  expect(contract(null, true).missing).toEqual(['named owner', 'durable claim receipt']);
  expect(interjectOutcome(AT, true, null, NOW)).toMatchObject({ stage: 'acked', text: 'acked' });
  expect(interjectOutcome(AT, false, null, NOW)).toMatchObject({ stage: 'sent', text: 'sent' });
});

it('uses the entry time as receivedAt when it parses, else unknown', () => {
  expect(contract(null, false, '2026-10-31T12:00:00Z').asOf).toBe('2026-10-31T12:00:00.000Z');
  expect(contract(null, false, '2026-11-01 00:08').asOf).toBe('2026-11-01T04:08:00.000Z');
  expect(contract(null, false, '—').asOf).toBe('unknown');
});

it('queued with a lane is RECEIVED missing the claim receipt', () => {
  const c = contract(trace(job('queued')));
  expect(c.state).toBe('RECEIVED');
  expect(c.missing).toEqual(['durable claim receipt']);
});

it('launched with a null lane is RECEIVED missing the owner', () => {
  const c = contract(trace(job('launched', null)));
  expect(c.state).toBe('RECEIVED');
  expect(c.missing).toEqual(['named owner']);
});

it('launched and published with a lane are ASSIGNED, never RUNNING', () => {
  expect(contract(trace(job('launched'))).state).toBe('ASSIGNED');
  expect(contract(trace(job('published'))).state).toBe('ASSIGNED');
  expect(interjectOutcome(AT, false, trace(job('launched')), NOW).text).toBe('job RQ-PHX-FAKE01 running');
});

it('picks the most advanced job', () => {
  expect(contract(trace(job('queued'), job('published'))).state).toBe('ASSIGNED');
});

it('merged PR url is VERIFIED as of the trace time', () => {
  const out = interjectOutcome(AT, false, trace(job('merged', 'claude', PR)), NOW);
  expect(out).toMatchObject({ stage: 'merged', text: 'merged #77', contract: { state: 'VERIFIED', asOf: GEN, missing: [] } });
});

it('merged without a PR url is not VERIFIED', () => {
  expect(contract(trace(job('merged'))).state).not.toBe('VERIFIED');
  expect(contract(trace(job('merged', 'claude', 'https://example.com/pull/77'))).state).not.toBe('VERIFIED');
  expect(contract(trace(job('merged', 'claude', 'https://github.com/other/repo/pull/7'))).state).not.toBe('VERIFIED');
});
