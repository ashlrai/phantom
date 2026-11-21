import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { readUnifiedBusStatus, type UnifiedBusStatusOptions } from '../src/core/agents/bus-status.js';
import { announceWork, sendDirectMessage, sendWakeRequest, type UnifiedBusOptions } from '../src/core/agents/bus-unified.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(at = 1_000): UnifiedBusStatusOptions & { clock: { now: number } } {
  const base = mkdtempSync(join(tmpdir(), 'agent-bus-status-'));
  dirs.push(base);
  const clock = { now: at };
  return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => clock.now, clock };
}

describe('readUnifiedBusStatus', () => {
  it('reports every dependency missing or empty on a fresh root, never zeroing unknowns', () => {
    const status = readUnifiedBusStatus(setup());
    expect(status.store).toMatchObject({ source: 'missing', retainedCount: null, retainedBytes: null,
      liveCount: null, expiredCount: null, maxMessages: 1024, maxBytes: 1024 * 1024 });
    // A verifiably absent registry holds no identities: 0 is the real count.
    expect(status.registry).toEqual({ source: 'missing', identities: 0, channels: 0 });
    expect(status.wakes).toEqual({ state: 'missing', hints: null });
    expect(status.coordination).toEqual({ source: 'missing', liveClaims: null, statuses: null });
    expect(status.workClaims).toEqual({ source: 'missing', claims: null });
    // A missing store is an empty feed, matching `work feed` semantics.
    expect(status.feed).toEqual({ status: 'ok', jobs: 0 });
    expect(Number.isNaN(Date.parse(status.asOf))).toBe(false);
  });

  it('counts real rows across all six sections after bus activity', async () => {
    const options = setup();
    const bus: UnifiedBusOptions = options;
    for (const handle of ['atlas', 'nova']) {
      expect(registerAgentIdentity({ handle,
        runtime: { cli: 'claude', provider: 'claude', model: null } }, options).status).toBe('created');
    }
    expect(await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'ping', id: 'dm-1' }, bus))
      .toMatchObject({ status: 'posted' });
    expect(await sendWakeRequest({ from: 'atlas', to: 'nova', reason: 'check inbox', id: 'wk-1' }, bus))
      .toMatchObject({ status: 'posted' });
    expect(await announceWork({ from: 'atlas', jobId: 'RQ-S-1', title: 'Status probe', repo: 'a/b',
      claimKeys: ['repo:a/b'], provider: 'claude', id: 'w-1' }, bus)).toMatchObject({ status: 'posted' });
    const at = options.now();
    expect(acquireCoordination({ root: options.root, origin: 'resource', key: 'queue:RQ-S-1',
      owner: 'agent:nova', leaseMs: 60_000, leaseUntil: at + 60_000, sourceId: 'test:1', now: at }).status)
      .toBe('acquired');

    const status = readUnifiedBusStatus(options);
    expect(status.store.source).toBe('available');
    expect(status.store.retainedCount).toBeGreaterThanOrEqual(3);
    expect(status.store.liveCount).toBe(status.store.retainedCount);
    expect(status.registry).toEqual({ source: 'available', identities: 2, channels: 0 });
    expect(status.wakes.state).toBe('ok');
    expect(status.wakes.hints).toBeGreaterThanOrEqual(1);
    expect(status.coordination.source).toBe('available');
    expect(status.coordination.liveClaims).toBe(1);
    expect(status.feed).toEqual({ status: 'ok', jobs: 1 });
  });

  it('keeps an unreadable registry unknown while the rest of the bus stays readable', () => {
    const options = setup();
    // Register first so the private directory chain exists with correct modes,
    // then corrupt only the registry payload.
    expect(registerAgentIdentity({ handle: 'atlas' }, options).status).toBe('created');
    const file = join(options.root!, 'agent-identities', 'registry.json');
    writeFileSync(file, '{not json');
    chmodSync(file, 0o600);
    const status = readUnifiedBusStatus(options);
    expect(status.registry).toEqual({ source: 'unavailable', identities: null, channels: null });
    expect(status.store.source).toBe('missing');
    expect(status.feed.status).toBe('ok');
  });

  it('surfaces a refused work feed with its reason instead of an empty job list', () => {
    const options = setup();
    const bus: UnifiedBusOptions = options;
    expect(registerAgentIdentity({ handle: 'atlas' }, options).status).toBe('created');
    // A retained post with no resolvable provider poisons the whole projection.
    expect(appendBusInbox({ id: 'poison-1', from: 'agent:ghost', to: 'leaders', priority: 'P2', ttl: 60_000,
      body: { kind: 'work.post', jobId: 'RQ-POISON', title: 'x', repo: 'a/b', claimKeys: [] } }, bus).status)
      .toBe('posted');
    const status = readUnifiedBusStatus(options);
    expect(status.feed.status).toBe('refused');
    expect(status.feed.jobs).toBeNull();
    expect(status.feed.reason).toContain('missing-provider');
    // The probe names the retained receipt the projection blamed.
    expect(status.feed.receipt).toBe('poison-1');
    // The store itself is still readable and counted.
    expect(status.store.source).toBe('available');
    expect(status.store.retainedCount).toBe(1);
  });

  it('counts retained message-id claim records and degrades only that section when the journal is unreadable', () => {
    // mutateBusWorkClaim reads the wall clock, so this probe needs real time.
    const options = setup(Date.now());
    const envelope: BusEnvelope = { id: 'w-claim-1', from: 'agent:nova', to: 'agent:atlas',
      priority: 'P2', ttl: 120_000, body: { kind: 'work', text: 'fake work' } };
    expect(appendBusInbox(envelope, { root: options.root, now: options.now }).status).toBe('posted');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'w-claim-1', owner: 'agent:atlas',
      leaseMs: 60_000, root: options.root }).status).toBe('acquired');

    const status = readUnifiedBusStatus(options);
    expect(status.workClaims).toEqual({ source: 'available', claims: 1 });
    // The same acquire also took a coordination lease under queue:w-claim-1.
    expect(status.coordination.liveClaims).toBe(1);

    // Corrupt only the journal payload; every other section still reads.
    const file = join(options.root!, 'bus-work-claims', 'claims.json');
    writeFileSync(file, '{not json');
    chmodSync(file, 0o600);
    const degraded = readUnifiedBusStatus(options);
    expect(degraded.workClaims).toEqual({ source: 'unavailable', claims: null });
    expect(degraded.store.source).toBe('available');
    expect(degraded.coordination.source).toBe('available');
    expect(degraded.feed.status).toBe('ok');
  });
});

describe('phm agents bus status', () => {
  it('prints one honest line per section in human mode and the object as JSON', async () => {
    const options = setup();
    const out: string[] = [], err: string[] = [];
    const code = await runAgentsBusUnified(['status', '--root', options.root!, '--json'],
      t => out.push(t), t => err.push(t), {});
    expect(code).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.store.source).toBe('missing');
    expect(json.registry.identities).toBe(0);
    expect(json.wakes.state).toBe('missing');
    expect(json.workClaims).toEqual({ source: 'missing', claims: null });
    expect(json.feed.status).toBe('ok');

    const text: string[] = [];
    expect(await runAgentsBusUnified(['status', '--root', options.root!], t => text.push(t), () => {}, {})).toBe(0);
    const lines = text.join('\n').split('\n');
    expect(lines[0]).toMatch(/^store missing /);
    expect(lines.join('\n')).toContain('workClaims missing claims=unknown');
    expect(lines.join('\n')).toContain('feed ok jobs=0');
    expect(lines.join('\n')).toContain('wakes missing hints=unknown');
  });
});
