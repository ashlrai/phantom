// @vitest-environment jsdom
/** RQ-PHX-ORDEREXECJOIN390 — join each order row's owner job to the live
 * claim-execution evidence in the "Your orders" strip. Fake ids only. */
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../src/web-ui/data/cache.js';
import { OrderStateStrip } from '../src/web-ui/routes/verse/fleet-board/OrderStateStrip.js';
import { orderExecutionText } from '../src/web-ui/routes/verse/fleet-board/order-execution-join.js';

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const report = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: '2026-11-14T23:00:00Z',
  report: {
    schema: 'fleet.claim-execution.v1', authority: 'none', asOf: '2026-11-14T23:00:00Z',
    ledger: 'known', processes: 'healthy', rows,
    counts: { running: 0, claimedNoWorker: 0, unknown: 0 }, reasons: [], ...over,
  },
});
const row = (jobId: string | null, state: string, worker: unknown = null) => ({
  claimId: `fake-claim-${jobId ?? 'none'}`, agent: 'fake-agent', repo: 'ashlrai/phantom',
  jobId, state, worker, expiresInSeconds: 120,
});
const worker = (pid: number, over: Record<string, unknown> = {}) => ({
  pid, lane: 'devin', tier: 'work', ageSeconds: 360, ...over,
});

describe('orderExecutionText', () => {
  it.each([undefined, null, ''])('shows nothing without an owner job (%j)', (ownerJob) => {
    const body = report([row('RQ-PHX-X', 'RUNNING', worker(1))]);
    expect(orderExecutionText(ownerJob, body)).toBeNull();
  });

  it.each([undefined, null, 42, 'garbage', [1], { v: 2, report: { ledger: 'known', processes: 'healthy', rows: [] } }])(
    'reads a missing or unreadable body %j as execution unknown', (body) => {
      expect(orderExecutionText('RQ-PHX-X', body)).toBe('execution unknown');
    });

  it.each([{ v: 1 }, { v: 1, asOf: '2026-11-14T23:00:00Z', sources: {}, orders: [] }, { v: 1, report: 'unavailable' }, { v: 1, report: 7 }])(
    'shows nothing for a v:1 body that is not the claim-execution envelope %j', (body) => {
      expect(orderExecutionText('RQ-PHX-X', body)).toBeNull();
    });

  it.each([
    ['ledger unavailable', { ledger: 'unavailable' }],
    ['processes unavailable', { processes: 'unavailable' }],
    ['rows not an array', { rows: 'nope' }],
    ['ledger of the wrong type', { ledger: 7 }],
  ])('reads %s as execution unknown', (_label, over) => {
    const body = report([row('RQ-PHX-X', 'CLAIMED_NO_WORKER')], over);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('execution unknown');
  });

  it('reads a live worker as "running pid N on lane, age"', () => {
    const body = report([row('RQ-PHX-RUNJOB', 'RUNNING', worker(4321, { lane: 'devin', ageSeconds: 360 }))]);
    expect(orderExecutionText('RQ-PHX-RUNJOB', body)).toBe('running pid 4321 on devin, 6m old');
  });

  it('picks the youngest worker when several RUNNING rows match', () => {
    const body = report([
      row('RQ-PHX-X', 'RUNNING', worker(111, { ageSeconds: 900 })),
      row('RQ-PHX-X', 'RUNNING', worker(222, { lane: 'codex', ageSeconds: 120 })),
      row('RQ-PHX-X', 'RUNNING', worker(333, { lane: 'claude', ageSeconds: 7200 })),
    ]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('running pid 222 on codex, 2m old');
  });

  it('keeps the first worker when youngest ages tie', () => {
    const body = report([
      row('RQ-PHX-X', 'RUNNING', worker(111, { ageSeconds: 120 })),
      row('RQ-PHX-X', 'RUNNING', worker(222, { lane: 'codex', ageSeconds: 120 })),
    ]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('running pid 111 on devin, 2m old');
  });

  it('reads a worker without a usable age as "age unknown"', () => {
    const body = report([row('RQ-PHX-X', 'RUNNING', worker(99, { ageSeconds: null }))]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('running pid 99 on devin, age unknown');
  });

  it.each(['bad lane!', 'a'.repeat(41), '', 'no/slash', 7, null])(
    'marks an unsafe lane %j as unknown lane', (lane) => {
      const body = report([row('RQ-PHX-X', 'RUNNING', worker(5, { lane, ageSeconds: 60 }))]);
      expect(orderExecutionText('RQ-PHX-X', body)).toBe('running pid 5 on unknown lane, 1m old');
    });

  it.each([0, -3, 1.5, '4321', Number.MAX_SAFE_INTEGER + 1])(
    'reads a RUNNING row with pid %j as execution unknown', (pid) => {
      const body = report([row('RQ-PHX-X', 'RUNNING', worker(pid as never))]);
      expect(orderExecutionText('RQ-PHX-X', body)).toBe('execution unknown');
    });

  it('reads a RUNNING row with no worker as execution unknown', () => {
    const body = report([row('RQ-PHX-X', 'RUNNING', null)]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('execution unknown');
  });

  it('reads claims with no worker as "no live worker"', () => {
    const body = report([row('RQ-PHX-X', 'CLAIMED_NO_WORKER'), row('RQ-PHX-X', 'CLAIMED_NO_WORKER')]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('no live worker');
  });

  it('reads UNKNOWN-only matches as execution unknown', () => {
    const body = report([row('RQ-PHX-X', 'UNKNOWN'), row('RQ-PHX-X', 'UNKNOWN')]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('execution unknown');
  });

  it('reads a murky mix (UNKNOWN + CLAIMED_NO_WORKER) as execution unknown', () => {
    const body = report([row('RQ-PHX-X', 'CLAIMED_NO_WORKER'), row('RQ-PHX-X', 'UNKNOWN')]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('execution unknown');
  });

  it('lets a usable RUNNING row win over sibling CLAIMED_NO_WORKER rows', () => {
    const body = report([
      row('RQ-PHX-X', 'CLAIMED_NO_WORKER'),
      row('RQ-PHX-X', 'RUNNING', worker(42, { ageSeconds: 60 })),
    ]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('running pid 42 on devin, 1m old');
  });

  it('reads a healthy report with no row for the job as "no live claim"', () => {
    expect(orderExecutionText('RQ-PHX-X', report([]))).toBe('no live claim');
    const body = report([row('RQ-PHX-OTHER', 'RUNNING', worker(1, { ageSeconds: 10 }))]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('no live claim');
  });

  it('matches the owner job id exactly', () => {
    const body = report([row('RQ-PHX-XYZ', 'CLAIMED_NO_WORKER'), row('rq-phx-x', 'CLAIMED_NO_WORKER'), row(null, 'CLAIMED_NO_WORKER')]);
    expect(orderExecutionText('RQ-PHX-X', body)).toBe('no live claim');
  });
});

describe('OrderStateStrip execution suffix', () => {
  const mk = (state: string, i: number, owner?: unknown) => ({
    at: '2026-11-14T22:29:00.000Z', source: 'slack', key: `order-fake-${i}`, state,
    asOf: '2026-11-14T22:30:00.000Z', evidenceSource: 'ledger', missing: [], pr: null,
    ...(owner === undefined ? {} : { owner }),
  });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('shows a RUNNING suffix on one row, "no live worker" on another, none without an owner', async () => {
    const orders = {
      v: 1, asOf: '2026-11-14T23:00:00Z', sources: {}, orders: [
        mk('RUNNING', 1, { job: 'RQ-PHX-RUNJOB', lane: 'devin' }),
        mk('ASSIGNED', 2, { job: 'RQ-PHX-IDLEJOB', lane: 'codex' }),
        mk('RECEIVED', 3, null),
      ],
    };
    const exec = report([
      row('RQ-PHX-RUNJOB', 'RUNNING', worker(4321, { lane: 'devin', ageSeconds: 360 })),
      row('RQ-PHX-IDLEJOB', 'CLAIMED_NO_WORKER'),
    ]);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) =>
      json(String(input).includes('/claim-execution') ? exec : orders)));
    render(createElement(OrderStateStrip));
    await waitFor(() => expect(
      screen.getByText('owner: RQ-PHX-RUNJOB (devin) · running pid 4321 on devin, 6m old')).toBeInTheDocument());
    expect(screen.getByText('owner: RQ-PHX-IDLEJOB (codex) · no live worker')).toBeInTheDocument();
    expect(screen.getAllByText('owner: no owner')).toHaveLength(1);
  });

  it('keeps order rows intact when the claim-execution read fails', async () => {
    const orders = {
      v: 1, asOf: '2026-11-14T23:00:00Z', sources: {}, orders: [mk('ASSIGNED', 1, { job: 'RQ-PHX-X', lane: 'devin' })],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).includes('/claim-execution')
      ? new Response('gone', { status: 404 }) : json(orders)));
    render(createElement(OrderStateStrip));
    await waitFor(() => expect(screen.getByText(/execution unknown/)).toBeInTheDocument());
    expect(screen.getByText('ASSIGNED')).toBeInTheDocument();
  });
});
