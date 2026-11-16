import { describe, expect, it } from 'vitest';
import {
  backoffDelay, checkTransportEnvelope, createBusRouter, createMemoryDeadLetterSink, fromBusEnvelope, toBusEnvelope,
  type BusRouterOptions, type BusTransport, type TransportEnvelope, type TransportHealthState, type TransportSendResult,
} from '../src/core/fleet/bus-transport.js';

type Step = TransportSendResult | 'throw';

interface Fake extends BusTransport { sent: TransportEnvelope[]; healthCalls: number }

/** Scripted fake: each send consumes the next step; the last step repeats. */
function fake(id: string, opts: { boundary?: 'local' | 'external'; health?: TransportHealthState | 'throw' | 'hang'; steps?: Step[] } = {}): Fake {
  const steps = opts.steps ?? [{ ok: true, receipt: `${id}-r`, duplicate: false }];
  let index = 0;
  const transport: Fake = {
    id, boundary: opts.boundary ?? 'local', sent: [], healthCalls: 0,
    async send(envelope) {
      transport.sent.push(envelope);
      const step = steps[Math.min(index++, steps.length - 1)]!;
      if (step === 'throw') throw new Error('secret-bearing failure text');
      return step;
    },
    async poll() { return { ok: true, messages: [], next: '0' }; },
    async ack() { return { ok: true, replayed: false }; },
    async health() {
      transport.healthCalls++;
      if (opts.health === 'throw') throw new Error('boom');
      if (opts.health === 'hang') return new Promise(() => {});
      return { state: opts.health ?? 'up' };
    },
  };
  return transport;
}

const envelope = (over: Partial<TransportEnvelope> = {}): TransportEnvelope => ({
  id: 'msg-1', from: 'agent:planner', to: 'reviewer', kind: 'task', priority: 'P1',
  body: { text: 'review this' }, correlationId: 'corr-1', ttlMs: 60_000, ...over,
});

function clockRouter(options: Omit<BusRouterOptions, 'now' | 'sleep' | 'deadLetter'> & Partial<BusRouterOptions>) {
  let clock = 1_000;
  const sleeps: number[] = [];
  const deadLetter = createMemoryDeadLetterSink();
  const router = createBusRouter({
    deadLetter, now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    ...options,
  });
  return { router, sleeps, deadLetter, advance: (ms: number) => { clock += ms; } };
}

const RETRY: TransportSendResult = { ok: false, retryable: true, reason: 'busy' };
const REFUSE: TransportSendResult = { ok: false, retryable: false, reason: 'no' };
const OK: TransportSendResult = { ok: true, receipt: 'r-1', duplicate: false };

describe('envelope mapping', () => {
  it('round-trips through the bus v1 wire form with a protocol body', () => {
    const wire = toBusEnvelope(envelope())!;
    expect(wire).toEqual({
      id: 'msg-1', from: 'agent:planner', to: 'reviewer', priority: 'P1', ttl: 60_000,
      body: { protocol: { version: 1, kind: 'task' }, correlation_id: 'corr-1', payload: { text: 'review this' } },
    });
    expect(fromBusEnvelope(wire)).toEqual(envelope());
  });

  it('rejects envelopes the bus cannot carry', () => {
    expect(checkTransportEnvelope(envelope({ kind: 'shout' as never }))).toBeNull();
    expect(checkTransportEnvelope(envelope({ correlationId: 'has space' }))).toBeNull();
    expect(checkTransportEnvelope(envelope({ priority: 'P9' as never }))).toBeNull();
    expect(checkTransportEnvelope(envelope({ ttlMs: 0 }))).toBeNull();
    expect(checkTransportEnvelope(envelope({ body: { big: 'x'.repeat(70_000) } }))).toBeNull();
    expect(fromBusEnvelope({ id: 'a', from: 'b', to: 'c', priority: 'P2', ttl: 1, body: { kind: 'note' } })).toBeNull();
  });

  it('computes capped exponential backoff', () => {
    const backoff = { baseMs: 100, factor: 2, maxMs: 500 };
    expect([1, 2, 3, 4, 5].map(attempt => backoffDelay(attempt, backoff))).toEqual([100, 200, 400, 500, 500]);
  });
});

describe('routing', () => {
  it('prefers healthy over degraded, then route priority, and skips down transports', async () => {
    const degraded = fake('degraded-fast', { health: 'degraded' });
    const slow = fake('up-slow');
    const fast = fake('up-fast');
    const down = fake('down', { health: 'down' });
    const { router } = clockRouter({
      routes: [
        { transport: down, roles: ['reviewer'], priority: 0 },
        { transport: degraded, roles: ['reviewer'], priority: 0 },
        { transport: slow, roles: ['*'], priority: 5 },
        { transport: fast, roles: ['review*'], priority: 1 },
      ],
    });
    const plan = await router.plan('reviewer');
    expect(plan.live.map(entry => entry.transport)).toEqual(['up-fast', 'up-slow', 'degraded-fast']);
    expect(plan.skipped).toEqual([{ transport: 'down', reason: 'down' }]);
    const report = await router.deliver(envelope());
    expect(report).toMatchObject({ status: 'delivered', transport: 'up-fast', receipt: 'up-fast-r', duplicate: false });
    expect(down.sent).toHaveLength(0);
    expect(degraded.sent).toHaveLength(0);
  });

  it('only routes to transports serving the addressed role', async () => {
    const reviewers = fake('reviewers');
    const planners = fake('planners');
    const { router } = clockRouter({
      routes: [
        { transport: reviewers, roles: ['reviewer'], priority: 0 },
        { transport: planners, roles: ['agent:*'], priority: 0 },
      ],
    });
    expect(await router.deliver(envelope({ to: 'agent:planner' }))).toMatchObject({ transport: 'planners' });
    expect(reviewers.sent).toHaveLength(0);
  });

  it('dead-letters immediately when no transport serves the role', async () => {
    const only = fake('only');
    const { router, deadLetter, sleeps } = clockRouter({ routes: [{ transport: only, roles: ['reviewer'], priority: 0 }] });
    const report = await router.deliver(envelope({ to: 'nobody' }));
    expect(report).toMatchObject({ status: 'dead-lettered', reason: 'no-route', recorded: true, attempts: [] });
    expect(deadLetter.entries.map(entry => entry.reason)).toEqual(['no-route']);
    expect(sleeps).toEqual([]);
  });

  it('treats a throwing or hanging health probe as down', async () => {
    const throws = fake('throws', { health: 'throw' });
    const hangs = fake('hangs', { health: 'hang' });
    const fine = fake('fine');
    const { router } = clockRouter({
      healthTimeoutMs: 5,
      routes: [
        { transport: throws, roles: ['*'], priority: 0 },
        { transport: hangs, roles: ['*'], priority: 0 },
        { transport: fine, roles: ['*'], priority: 9 },
      ],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'delivered', transport: 'fine' });
  });

  it('refuses invalid routes and options at construction', () => {
    const t = fake('t');
    const deadLetter = createMemoryDeadLetterSink();
    expect(() => createBusRouter({ deadLetter, routes: [{ transport: t, roles: [], priority: 0 }] })).toThrow(TypeError);
    expect(() => createBusRouter({ deadLetter, routes: [
      { transport: t, roles: ['*'], priority: 0 }, { transport: t, roles: ['*'], priority: 1 },
    ] })).toThrow(TypeError);
    expect(() => createBusRouter({ deadLetter, maxAttempts: 0, routes: [] })).toThrow(TypeError);
    expect(() => createBusRouter({ deadLetter, backoff: { factor: 0.5 }, routes: [] })).toThrow(TypeError);
  });

  it('returns invalid without sending or dead-lettering', async () => {
    const t = fake('t');
    const { router, deadLetter } = clockRouter({ routes: [{ transport: t, roles: ['*'], priority: 0 }] });
    expect(await router.deliver(envelope({ to: 'bad address' }))).toEqual({ status: 'invalid', reason: expect.any(String) });
    expect(t.sent).toHaveLength(0);
    expect(deadLetter.entries).toHaveLength(0);
  });
});

describe('retry and receipts', () => {
  it('retries a retryable failure with exponential backoff and returns a receipt', async () => {
    const flaky = fake('flaky', { steps: [RETRY, 'throw', OK] });
    const { router, sleeps } = clockRouter({
      backoff: { baseMs: 100, factor: 3, maxMs: 10_000 },
      routes: [{ transport: flaky, roles: ['*'], priority: 0 }],
    });
    const report = await router.deliver(envelope());
    expect(sleeps).toEqual([100, 300]);
    expect(report).toMatchObject({ status: 'delivered', transport: 'flaky', receipt: 'r-1', id: 'msg-1', correlationId: 'corr-1' });
    if (report.status !== 'delivered') throw new Error('unreachable');
    expect(report.attempts.map(a => [a.attempt, a.outcome])).toEqual([[1, 'retryable'], [2, 'retryable'], [3, 'delivered']]);
    // A thrown error is recorded with a static reason, never its message.
    expect(JSON.stringify(report)).not.toContain('secret-bearing');
  });

  it('fails over to the next live transport within the same attempt', async () => {
    const first = fake('first', { steps: [RETRY] });
    const second = fake('second');
    const { router, sleeps } = clockRouter({
      routes: [{ transport: first, roles: ['*'], priority: 0 }, { transport: second, roles: ['*'], priority: 1 }],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'delivered', transport: 'second' });
    expect(sleeps).toEqual([]);
  });

  it('decrements the TTL by elapsed time on each resend', async () => {
    const flaky = fake('flaky', { steps: [RETRY, OK] });
    const { router } = clockRouter({ backoff: { baseMs: 1_000 }, routes: [{ transport: flaky, roles: ['*'], priority: 0 }] });
    await router.deliver(envelope());
    expect(flaky.sent.map(e => e.ttlMs)).toEqual([60_000, 59_000]);
  });

  it('stops using a transport after a permanent refusal', async () => {
    const refuses = fake('refuses', { steps: [REFUSE] });
    const flaky = fake('flaky', { steps: [RETRY, OK] });
    const { router } = clockRouter({
      routes: [{ transport: refuses, roles: ['*'], priority: 0 }, { transport: flaky, roles: ['*'], priority: 1 }],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'delivered', transport: 'flaky' });
    expect(refuses.sent).toHaveLength(1);
  });
});

describe('dead-letter', () => {
  it('dead-letters after N failed attempts and keeps the attempt log', async () => {
    const broken = fake('broken', { steps: [RETRY] });
    const { router, sleeps, deadLetter } = clockRouter({
      maxAttempts: 3, backoff: { baseMs: 10, factor: 2, maxMs: 1_000 },
      routes: [{ transport: broken, roles: ['*'], priority: 0 }],
    });
    const report = await router.deliver(envelope());
    expect(report).toMatchObject({ status: 'dead-lettered', reason: 'exhausted', recorded: true });
    expect(broken.sent).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]);
    expect(deadLetter.entries).toHaveLength(1);
    expect(deadLetter.entries[0]!.envelope).toEqual(envelope());
    expect(deadLetter.entries[0]!.attempts.map(a => a.outcome)).toEqual(['retryable', 'retryable', 'retryable']);
  });

  it('does not keep retrying once every candidate refused permanently', async () => {
    const refuses = fake('refuses', { steps: [REFUSE] });
    const { router, sleeps } = clockRouter({ maxAttempts: 5, routes: [{ transport: refuses, roles: ['*'], priority: 0 }] });
    const report = await router.deliver(envelope());
    expect(report).toMatchObject({ status: 'dead-lettered', reason: 'exhausted' });
    expect(refuses.sent).toHaveLength(1);
    expect(sleeps).toHaveLength(1);
  });

  it('retries while every transport is down, then dead-letters', async () => {
    const down = fake('down', { health: 'down' });
    const { router } = clockRouter({ maxAttempts: 2, routes: [{ transport: down, roles: ['*'], priority: 0 }] });
    const report = await router.deliver(envelope());
    expect(report).toMatchObject({ status: 'dead-lettered', reason: 'exhausted' });
    if (report.status !== 'dead-lettered') throw new Error('unreachable');
    expect(report.attempts.map(a => a.outcome)).toEqual(['no-live-transport', 'no-live-transport']);
    expect(down.sent).toHaveLength(0);
  });

  it('dead-letters as expired when the TTL runs out during backoff', async () => {
    const broken = fake('broken', { steps: [RETRY] });
    const { router } = clockRouter({
      maxAttempts: 10, backoff: { baseMs: 400, factor: 1, maxMs: 400 },
      routes: [{ transport: broken, roles: ['*'], priority: 0 }],
    });
    const report = await router.deliver(envelope({ ttlMs: 1_000 }));
    expect(report).toMatchObject({ status: 'dead-lettered', reason: 'expired' });
    expect(broken.sent).toHaveLength(3);
  });

  it('reports recorded false when the sink fails', async () => {
    const broken = fake('broken', { steps: [RETRY] });
    const router = createBusRouter({
      maxAttempts: 1, sleep: async () => {},
      deadLetter: { async put() { throw new Error('disk'); } },
      routes: [{ transport: broken, roles: ['*'], priority: 0 }],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'dead-lettered', recorded: false });
  });
});

describe('owner-approval gate', () => {
  it('holds when only external transports serve the role, without contacting them', async () => {
    const external = fake('remote', { boundary: 'external' });
    const { router, deadLetter } = clockRouter({ routes: [{ transport: external, roles: ['*'], priority: 0 }] });
    const report = await router.deliver(envelope());
    expect(report).toMatchObject({ status: 'held', id: 'msg-1', correlationId: 'corr-1' });
    expect(external.sent).toHaveLength(0);
    expect(external.healthCalls).toBe(0);
    expect(deadLetter.entries).toHaveLength(0);
  });

  it('routes locally and never selects an external transport while egress is off', async () => {
    const external = fake('remote', { boundary: 'external' });
    const local = fake('local', { steps: [RETRY] });
    const { router } = clockRouter({
      maxAttempts: 2,
      routes: [{ transport: external, roles: ['*'], priority: 0 }, { transport: local, roles: ['*'], priority: 9 }],
    });
    const plan = await router.plan('reviewer');
    expect(plan.skipped).toContainEqual({ transport: 'remote', reason: 'egress-not-approved' });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'dead-lettered' });
    expect(external.sent).toHaveLength(0);
    expect(external.healthCalls).toBe(0);
  });

  it('does not treat a truthy look-alike as approval', async () => {
    const external = fake('remote', { boundary: 'external' });
    const { router } = clockRouter({
      egress: { ownerApproved: 'yes' } as unknown as { ownerApproved: true },
      routes: [{ transport: external, roles: ['*'], priority: 0 }],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'held' });
    expect(external.sent).toHaveLength(0);
  });

  it('selects an external transport only with explicit owner approval', async () => {
    const external = fake('remote', { boundary: 'external' });
    const local = fake('local');
    const { router } = clockRouter({
      egress: { ownerApproved: true },
      routes: [{ transport: external, roles: ['*'], priority: 0 }, { transport: local, roles: ['*'], priority: 9 }],
    });
    expect(await router.deliver(envelope())).toMatchObject({ status: 'delivered', transport: 'remote' });
  });

  it('honours a host hold before any transport is touched', async () => {
    const local = fake('local');
    const { router } = clockRouter({ hold: () => 'Kill switch is on.', routes: [{ transport: local, roles: ['*'], priority: 0 }] });
    expect(await router.deliver(envelope())).toEqual({ status: 'held', id: 'msg-1', correlationId: 'corr-1', reason: 'Kill switch is on.' });
    expect(local.sent).toHaveLength(0);
    expect(local.healthCalls).toBe(0);
  });
});
