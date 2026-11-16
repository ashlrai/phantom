/** Exercises the read-only evidence collector and `fleet work-trace` command
 * against real durable stores in a private tmp root. Labels and tokens grant
 * no authority; claim tokens are asserted absent from every output. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem, RUNNING_FRESH_MS } from '../src/core/comms/work-item-state.js';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

let root: string, now: number;
const ID = 'RQ-PHX-FAKE-1';
const iso = (ms: number) => new Date(ms).toISOString();
const collect = (id = ID, at = now) => collectBusWorkItemEvidence(id, { root, now: at });
const classify = (id = ID, at = now) => classifyWorkItem(collect(id, at).evidence, iso(at));
const post = (id = ID, ttl = 10_000_000) => {
  expect(appendBusInbox({ id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl,
    body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
};
const acquire = (id = ID, leaseMs = 600_000) =>
  mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner', leaseMs, root });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-item-bus-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('collectBusWorkItemEvidence on real durable stores', { timeout: 60_000 }, () => {
  it('RECEIVED from an inbox receipt with no claim', () => {
    post();
    const { evidence, sources } = collect();
    expect(sources).toEqual({ inbox: 'found', claims: 'missing' });
    expect(evidence).toEqual({ id: ID, receivedAt: iso(now) });
    const r = classifyWorkItem(evidence, iso(now));
    expect(r.state).toBe('RECEIVED');
    expect(r.asOf).toBe(iso(now));
    expect(r.missing).toContain('named owner');
    expect(r.missing).toContain('durable claim receipt');
  });

  it('RUNNING from a live claim; claimReceipt present and no token leaks', () => {
    post();
    const claim = acquire();
    expect(claim.status).toBe('acquired');
    const { evidence, sources } = collect();
    expect(sources).toEqual({ inbox: 'found', claims: 'available' });
    expect(evidence.owner).toBe('fake-owner');
    expect(evidence.claimReceipt).toBe(`bus-claim:${ID}:1:${now}`);
    expect(evidence.runningEvidence).toEqual({
      source: `bus-work-claims lease-until ${iso(now + 600_000)}`, at: iso(now),
    });
    const r = classifyWorkItem(evidence, iso(now));
    expect(r).toMatchObject({ state: 'RUNNING', asOf: iso(now) });
    const serialized = JSON.stringify({ evidence, r });
    expect(serialized).toContain('bus-claim:');
    expect(serialized).not.toContain(claim.token!);
    expect(serialized).not.toMatch(/[a-f0-9]{64}/);
  });

  it('ASSIGNED once the lease has expired, with fresh running evidence missing', () => {
    post();
    acquire();
    const later = now + 600_000 + RUNNING_FRESH_MS + 1;
    const r = classify(ID, later);
    expect(r.state).toBe('ASSIGNED');
    expect(r.missing).toEqual(['fresh running evidence']);
    expect(r.source).toBe(`claim:bus-claim:${ID}:1:${now}`);
  });

  it('a completed claim without a reply is not VERIFIED', () => {
    post();
    const claim = acquire();
    now += 5_000;
    expect(mutateBusWorkClaim({ action: 'complete', id: ID, token: claim.token, root }).status).toBe('completed');
    const r = classify();
    expect(r.state).toBe('ASSIGNED');
    expect(r.state).not.toBe('VERIFIED');
  });

  it('VERIFIED only from a reply envelope carrying verified evidence', () => {
    post();
    const claim = acquire();
    now += 5_000;
    mutateBusWorkClaim({ action: 'complete', id: ID, token: claim.token, root });
    // A reply that names the request but carries no verified object proves nothing.
    expect(postBusReply(ID, 'fake-reply-plain', { text: 'done' }, { root, now: () => now }).outcome).toBe('posted');
    expect(classify().state).not.toBe('VERIFIED');
    now += 1_000;
    expect(postBusReply(ID, 'fake-reply-verified', { verified: { pr: 1, head: 'abc1234' } },
      { root, now: () => now }).outcome).toBe('posted');
    const { evidence } = collect();
    expect(evidence.verified).toEqual({ pr: 1, head: 'abc1234', tests: undefined, artifact: undefined,
      source: 'bus-reply:fake-reply-verified', at: iso(now) });
    const r = classifyWorkItem(evidence, iso(now));
    expect(r).toEqual({ state: 'VERIFIED', asOf: iso(now), source: 'bus-reply:fake-reply-verified', missing: [] });
  });

  it('an unknown id reports inbox missing and stays RECEIVED', () => {
    post();
    const { evidence, sources } = collect('RQ-NOPE');
    expect(sources.inbox).toBe('missing');
    const r = classifyWorkItem(evidence, iso(now));
    expect(r).toEqual({ state: 'RECEIVED', asOf: 'unknown', source: 'unknown',
      missing: ['named owner', 'durable claim receipt'] });
  });
});

describe('cmdFleetWorkTrace', { timeout: 60_000 }, () => {
  it('is registered and prints the classified line and object', async () => {
    expect(resolveFleetSubcommand('work-trace')).toEqual({ module: './fleet-work-trace.js', exportName: 'cmdFleetWorkTrace' });
    post();
    acquire();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root])).toBe(0);
    const line = String(log.mock.calls.at(-1)![0]);
    expect(line).toBe(`${ID} RUNNING as-of=${iso(now)} source=bus-work-claims lease-until ${iso(now + 600_000)} `
      + 'missing=none inbox=found claims=available');
    expect(line).not.toMatch(/[a-f0-9]{64}/);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root, '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ id: ID, state: 'RUNNING', asOf: iso(now), missing: [],
      inbox: 'found', claims: 'available' });
    expect(String(log.mock.calls.at(-1)![0])).not.toMatch(/[a-f0-9]{64}/);
  });

  it('a missing message is still exit 0 with inbox=missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace(['--id', 'RQ-NOPE', '--root', root, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({ id: 'RQ-NOPE', state: 'RECEIVED',
      asOf: 'unknown', source: 'unknown', missing: ['named owner', 'durable claim receipt'],
      inbox: 'missing', claims: 'missing' });
  });

  it('exits 2 on bad args and prints nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace([])).toBe(2);
    expect(await cmdFleetWorkTrace(['--root', root])).toBe(2);
    expect(await cmdFleetWorkTrace(['--id'])).toBe(2);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', 'relative/path'])).toBe(2);
    expect(await cmdFleetWorkTrace(['--id', ID, '--bogus'])).toBe(2);
    expect(await cmdFleetWorkTrace(['--id', ID, '--id', 'other', '--root', root])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
