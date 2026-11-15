import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, releaseFleetClaim, type FleetCoordinationOptions, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const REPO = 'ashlrai/phantom';
const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const dirs: string[] = [];

function fixture(now: number) {
  const dir = mkdtempSync(join(tmpdir(), 'return-handoff-reconnect-381s-'));
  dirs.push(dir);
  return { path: join(dir, 'coordination.jsonl'), now } satisfies FleetCoordinationOptions & { now: number };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

function ledgerEvents(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, any>);
}

function expectNoLeaseMaterial(serialized: string, leases: string[]) {
  expect(serialized).not.toContain('leaseHash');
  for (const lease of leases) expect(serialized).not.toContain(lease);
}

describe('handoff reconnect cannot steal or fabricate a return', () => {
  it('fences agent A stale lease after handoff to B while B returns once idempotently', () => {
    const options = fixture(1000);
    const claimed = must(claimFleetWork({ repo: REPO, task: 'handoff reconnect proof 381s', agent: AGENT_A }, options));
    const claimId = claimed.claim.id;
    const leaseA = claimed.lease;

    options.now = 2000;
    const handed = must(handoffFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA, to: AGENT_B }, options));
    const leaseB = handed.lease;
    expect(handed.claim).toMatchObject({ id: claimId, repo: REPO, agent: AGENT_B });
    expect(leaseB).not.toBe(leaseA);

    // A reconnects holding only its stale label and first lease.
    options.now = 3000;
    expect(releaseFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA }, options))
      .toMatchObject({ ok: false, error: 'not-owner' });
    expect(returnFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA, artifact: 'fake reconnect artifact' }, options))
      .toMatchObject({ ok: false, outcome: 'not-owner', claimId });
    // A's stale lease cannot impersonate B's label either.
    expect(releaseFleetClaim({ id: claimId, agent: AGENT_B, lease: leaseA }, options))
      .toMatchObject({ ok: false, error: 'not-owner' });
    expect(returnFleetClaim({ id: claimId, agent: AGENT_B, lease: leaseA, tests: 'fake suite' }, options))
      .toMatchObject({ ok: false, outcome: 'not-owner', claimId });

    // Durable re-read proves B is still the live holder and no receipt exists.
    const held = readFleetBoard(options);
    expect(held.state).toBe('known');
    expect(held.claims).toEqual([expect.objectContaining({ id: claimId, repo: REPO, agent: AGENT_B })]);
    expect(projectCoordinationReturns(held, options.now)).toMatchObject({ state: 'known', returns: [], unparsed: 0 });

    // The real new owner returns a plainly fake artifact on its own lease.
    options.now = 4000;
    const returned = returnFleetClaim({ id: claimId, agent: AGENT_B, lease: leaseB, artifact: 'fake-381s-proof-artifact.txt' }, options);
    expect(returned).toMatchObject({ ok: true, outcome: 'returned', claimId });

    // Re-open the ledger from disk: claim gone, exactly one projected result names B.
    const reopened = readFleetBoard(options);
    expect(reopened.claims).toEqual([]);
    const projection = projectCoordinationReturns(reopened, options.now);
    expect(projection).toMatchObject({ state: 'known', unparsed: 0 });
    expect(projection.returns).toEqual([expect.objectContaining({
      claimId, repo: REPO, from: AGENT_B, result: 'VERIFIED', evidenceKind: 'artifact',
      evidence: 'artifact fake-381s-proof-artifact.txt',
    })]);
    expectNoLeaseMaterial(JSON.stringify(projection), [leaseA, leaseB]);

    // Retrying B's return replays the durable receipt without a second post.
    options.now = 5000;
    expect(returnFleetClaim({ id: claimId, agent: AGENT_B, lease: leaseB, artifact: 'fake-381s-proof-artifact.txt' }, options))
      .toMatchObject({ ok: true, outcome: 'already-returned', claimId });
    const after = readFleetBoard(options);
    expect(after.claims).toEqual([]);
    expect(after.messages).toEqual([expect.objectContaining({ id: `return-${claimId}`, from: AGENT_B, to: 'all' })]);
    expect(projectCoordinationReturns(after, options.now).returns).toHaveLength(1);

    // Durable events: claim, handoff, release, post — no receipt from the stale context.
    const events = ledgerEvents(options.path);
    expect(events.map(event => event['kind'])).toEqual(['claim', 'handoff', 'release', 'post']);
    expect(events[1]).toMatchObject({ kind: 'handoff', claim: { id: claimId, agent: AGENT_B } });
    const raw = readFileSync(options.path, 'utf8');
    expect(raw).not.toContain(leaseA);
    expect(raw).not.toContain(leaseB);
  });

  it('rejects the first lease after a second handoff restores the original agent label', () => {
    const options = fixture(1000);
    const claimed = must(claimFleetWork({ repo: REPO, task: 'handoff round trip 381s', agent: AGENT_A }, options));
    const claimId = claimed.claim.id;
    const leaseA = claimed.lease;

    options.now = 2000;
    const toB = must(handoffFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA, to: AGENT_B }, options));
    options.now = 3000;
    // B hands the same claim back to the original agent label; a fresh lease is issued.
    const backToA = must(handoffFleetClaim({ id: claimId, agent: AGENT_B, lease: toB.lease, to: AGENT_A }, options));
    const leaseC = backToA.lease;
    expect(backToA.claim).toMatchObject({ id: claimId, agent: AGENT_A });
    expect(leaseC).not.toBe(leaseA);
    expect(leaseC).not.toBe(toB.lease);

    // Label equality cannot substitute for the current lease: A's first lease still fails.
    options.now = 4000;
    expect(releaseFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA }, options))
      .toMatchObject({ ok: false, error: 'not-owner' });
    expect(returnFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA, artifact: 'fake stale artifact' }, options))
      .toMatchObject({ ok: false, outcome: 'not-owner', claimId });
    expect(readFleetBoard(options).claims).toEqual([expect.objectContaining({ id: claimId, agent: AGENT_A })]);
    expect(projectCoordinationReturns(readFleetBoard(options), options.now).returns).toEqual([]);

    // The lease issued by the second handoff is the only credential that returns once.
    options.now = 5000;
    expect(returnFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseC, tests: 'fake suite passed' }, options))
      .toMatchObject({ ok: true, outcome: 'returned', claimId });
    const reopened = readFleetBoard(options);
    expect(reopened.claims).toEqual([]);
    expect(projectCoordinationReturns(reopened, options.now).returns).toEqual([expect.objectContaining({
      claimId, repo: REPO, from: AGENT_A, result: 'VERIFIED', evidenceKind: 'tests',
    })]);
    expectNoLeaseMaterial(JSON.stringify(projectCoordinationReturns(reopened, options.now)), [leaseA, toB.lease, leaseC]);

    const events = ledgerEvents(options.path);
    expect(events.map(event => event['kind'])).toEqual(['claim', 'handoff', 'handoff', 'release', 'post']);
    const raw = readFileSync(options.path, 'utf8');
    for (const lease of [leaseA, toB.lease, leaseC]) expect(raw).not.toContain(lease);
  });
});
