/** HTTP claim → real-helper handoff → stale-owner return → successor return →
 * durable replay, all over POST /api/verse/fleet/coordination-claims/{claim,return}
 * against a real temporary JSONL ledger. The API factory's claim/return seams
 * forward to the real claimFleetWork / returnFleetClaim on that ledger behind
 * a controlled clock; the handoff uses the real handoffFleetClaim helper. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimFleetWork,
  handoffFleetClaim,
  readFleetBoard,
  type FleetCoordinationOptions,
  type FleetCoordinationResult,
} from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import {
  VERSE_FLEET_COORDINATION_CLAIM_PATH as CLAIM,
  VERSE_FLEET_COORDINATION_RETURN_PATH as RETURN,
  createFleetCoordinationMutateApi,
} from '../src/core/verse/fleet-coordination-mutate-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const REPO = 'ashlrai/phantom';
const TASK = 'http handoff qualification 383s';
const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const HEAD = 'deadbeefcafe';
let dir: string;
let path: string;
let clock: number;
let options: FleetCoordinationOptions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coord-http-handoff-383s-'));
  path = join(dir, 'coordination.jsonl');
  clock = 1_000;
  options = { path, now: clock };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

/** A fresh API instance over the same durable ledger and the same clock. */
function api(): ApiModule {
  return createFleetCoordinationMutateApi({
    now: () => new Date(clock),
    claim: (input, at) => claimFleetWork(input, { path, now: at }),
    return: (input, at) => returnFleetClaim(input, { path, now: at }),
  });
}

async function call(mod: ApiModule, method: string, route: string, raw?: string) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: route }) as unknown as IncomingMessage;
  const pending = mod({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, route, method);
  if (raw !== undefined) {
    await Promise.resolve();
    req.emit('data', Buffer.from(raw, 'utf8'));
    req.emit('end');
  }
  const handled = await pending;
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

const post = (mod: ApiModule, route: string, body: unknown) =>
  call(mod, 'POST', route, JSON.stringify(body));

function board() {
  options.now = clock;
  return readFleetBoard(options);
}

function returns() {
  return projectCoordinationReturns(board(), clock);
}

describe('HTTP claim/return across a real handoff (383s)', () => {
  it('fences the stale lease over HTTP, lets the successor return once, and replays durably', async () => {
    const mod = api();

    // Acquire over HTTP: the lease is returned exactly once, in this 200 body.
    const claimed = await post(mod, CLAIM, { repo: REPO, task: TASK, agent: AGENT_A, ttlSeconds: 600 });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ ok: true, outcome: 'claimed', claim: { repo: REPO, task: TASK, agent: AGENT_A } });
    const claimId = claimed.body.claim.id as string;
    const leaseA = claimed.body.lease as string;
    expect(leaseA).toMatch(/^[0-9a-f-]{36}$/);

    // The real handoff helper moves ownership to B and issues a fresh lease.
    clock = 2_000;
    const handed = must(handoffFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA, to: AGENT_B }, options));
    const leaseB = handed.lease;
    expect(handed.claim).toMatchObject({ id: claimId, agent: AGENT_B });
    expect(leaseB).not.toBe(leaseA);

    // The disconnected old owner reconnects over HTTP with its original lease:
    // an honest rejection, no RESULT receipt, and B still owns the claim on disk.
    clock = 3_000;
    const stale = await post(mod, RETURN, { claimId, agent: AGENT_A, lease: leaseA, result: { tests: 'stale suite' } });
    expect(stale.status).toBe(403);
    expect(stale.body).toEqual({ ok: false, outcome: 'not-owner', claimId });
    expect(stale.text).not.toContain(leaseA);
    expect(stale.text).not.toContain(leaseB);
    expect(stale.text).not.toMatch(/RESULT/);

    // The successor's label cannot launder the stale lease either.
    const spoof = await post(mod, RETURN, { claimId, agent: AGENT_B, lease: leaseA, result: { artifact: 'fake.txt' } });
    expect(spoof.status).toBe(403);
    expect(spoof.body.outcome).toBe('not-owner');

    const held = board();
    expect(held.state).toBe('known');
    expect(held.claims).toEqual([expect.objectContaining({ id: claimId, repo: REPO, agent: AGENT_B })]);
    expect(returns()).toMatchObject({ state: 'known', returns: [], unparsed: 0 });
    expect(held.messages.filter(m => m.id === `return-${claimId}`)).toEqual([]);

    // The successor returns a blocked result over HTTP: evidence, not authority.
    clock = 4_000;
    const body = { claimId, agent: AGENT_B, lease: leaseB, result: { blocked: 'waiting on upstream dep' } };
    const returned = await post(mod, RETURN, body);
    expect(returned.status).toBe(200);
    expect(returned.body).toMatchObject({ ok: true, outcome: 'returned', claimId,
      message: { id: `return-${claimId}`, from: AGENT_B, to: 'all' } });
    expect(returned.body.message.body).toContain('RESULT BLOCKED');
    expect(returned.text).not.toContain(leaseB);
    expect(returned.text).not.toContain(leaseA);

    // Durable truth after release: no active claim, exactly one retained receipt,
    // projected as BLOCKED/dependency evidence with no authority fields.
    const settled = board();
    expect(settled.claims).toEqual([]);
    expect(settled.messages.filter(m => m.id === `return-${claimId}`)).toHaveLength(1);
    const view = returns();
    expect(view).toMatchObject({ state: 'known', unparsed: 0 });
    expect(view.returns).toEqual([expect.objectContaining({
      claimId, repo: REPO, result: 'BLOCKED', evidenceKind: 'dependency',
      evidence: 'dependency waiting on upstream dep', from: AGENT_B,
      at: new Date(4_000).toISOString(),
    })]);
    // A receipt is evidence only: the projection carries no execution authority.
    expect(Object.keys(view.returns[0]!).sort()).toEqual([
      'at', 'claimId', 'evidence', 'evidenceKind', 'expiresAt', 'from', 'head', 'pr', 'repo', 'result',
    ]);
    expect(settled.proposals).toEqual([]);

    // Replaying the identical request through a brand-new API instance is a
    // durable idempotent read of the posted receipt: still exactly one receipt.
    clock = 5_000;
    const replayed = await post(api(), RETURN, body);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ ok: true, outcome: 'already-returned', claimId });
    expect(replayed.text).not.toContain(leaseB);

    const after = board();
    expect(after.claims).toEqual([]);
    expect(after.messages.filter(m => m.id === `return-${claimId}`)).toHaveLength(1);
    expect(returns().returns).toHaveLength(1);

    // The ledger itself never holds lease material; event history is exactly
    // claim → handoff → release → post.
    const events = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, any>);
    expect(events.map(event => event['kind'])).toEqual(['claim', 'handoff', 'release', 'post']);
    expect(events[1]).toMatchObject({ kind: 'handoff', claim: { id: claimId, agent: AGENT_B } });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(leaseA);
    expect(raw).not.toContain(leaseB);
    // Only the SHA-256 hash is durable; neither lease value is ever written.
    expect(raw).toContain('leaseHash');
  });

  it('a second handoff back to A still fences the first lease over HTTP', async () => {
    const mod = api();
    const claimed = await post(mod, CLAIM, { repo: REPO, task: `${TASK} round trip`, agent: AGENT_A });
    expect(claimed.status).toBe(200);
    const claimId = claimed.body.claim.id as string;
    const leaseA = claimed.body.lease as string;

    clock = 2_000;
    const toB = must(handoffFleetClaim({ id: claimId, agent: AGENT_A, lease: leaseA, to: AGENT_B }, options));
    clock = 3_000;
    const backToA = must(handoffFleetClaim({ id: claimId, agent: AGENT_B, lease: toB.lease, to: AGENT_A }, options));
    const leaseC = backToA.lease;
    expect(leaseC).not.toBe(leaseA);
    expect(leaseC).not.toBe(toB.lease);

    // Label equality cannot substitute for the current lease.
    clock = 4_000;
    const stale = await post(mod, RETURN, { claimId, agent: AGENT_A, lease: leaseA, result: { pr: 7, head: HEAD } });
    expect(stale.status).toBe(403);
    expect(stale.body.outcome).toBe('not-owner');
    expect(stale.text).not.toContain(leaseA);
    expect(board().claims).toEqual([expect.objectContaining({ id: claimId, agent: AGENT_A })]);
    expect(returns().returns).toEqual([]);

    clock = 5_000;
    const done = await post(mod, RETURN, { claimId, agent: AGENT_A, lease: leaseC, result: { pr: 7, head: HEAD } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, outcome: 'returned', claimId });
    const settled = board();
    expect(settled.claims).toEqual([]);
    expect(settled.messages.filter(m => m.id === `return-${claimId}`)).toHaveLength(1);
    expect(returns().returns).toEqual([expect.objectContaining({
      claimId, result: 'VERIFIED', evidenceKind: 'pr', pr: 7, head: HEAD, from: AGENT_A,
    })]);
    const raw = readFileSync(path, 'utf8');
    for (const lease of [leaseA, toB.lease, leaseC]) expect(raw).not.toContain(lease);
  });
});
