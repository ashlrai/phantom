import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';

const REPO = 'ashlrai/phantom';
const TASK = 'expired owner return qualification 379s';
const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const TTL_A_MS = 60_000;
const TTL_B_MS = 3_600_000;
const SYNTHETIC_HEAD = 'a'.repeat(40);

let dir = '';
let ledgerPath = '';
let t0 = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'expired-owner-return-379s-'));
  ledgerPath = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledgerPath);
  t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

interface ClaimOutput {
  claim: { id: string; repo: string; task: string; agent: string; claimedAt: number; expiresAt: number };
  lease: string;
}

const lastText = () => String(vi.mocked(console.log).mock.calls.at(-1)![0]);
const at = (offsetMs: number) => vi.setSystemTime(t0 + offsetMs);

// Every invocation is a fresh cmdFleetCoordination call, so each board/returns
// read replays the ledger file from disk; nothing reuses a cached board.
async function cli(args: string[]) {
  const calls = vi.mocked(console.log).mock.calls.length;
  const code = await cmdFleetCoordination(args);
  const callsAfter = vi.mocked(console.log).mock.calls.length;
  const text = callsAfter === calls ? '' : lastText();
  return { code, json: (text ? JSON.parse(text) : null) as any, text };
}

async function claim(agent: string, ttlMs: number): Promise<ClaimOutput> {
  const { code, json } = await cli(['claim', '--repo', REPO, '--task', TASK, '--agent', agent,
    '--ttl-seconds', String(ttlMs / 1000), '--json']);
  expect(code).toBe(0);
  expect(json.ok).toBe(true);
  return json.value as ClaimOutput;
}

const board = () => cli(['board', '--json']);
const returns = () => cli(['returns', '--json']);
const release = (id: string, agent: string, lease: string) =>
  cli(['release', id, '--agent', agent, '--lease', lease, '--json']);
const ret = (id: string, agent: string, lease: string, evidence: string[]) =>
  cli(['return', id, '--agent', agent, '--lease', lease, ...evidence, '--json']);

function ledgerEvents(): Array<Record<string, any>> {
  return readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, any>);
}

function expectNoLeaseMaterial(text: string, leases: string[]) {
  expect(text).not.toContain('leaseHash');
  expect(text).not.toContain('lease');
  for (const lease of leases) expect(text).not.toContain(lease);
}

describe('expired owner cannot return or release the replacement claim', () => {
  it('fences agent A after reap while agent B claims, is fenced against, and returns blocked work', async () => {
    at(0);
    const claimA = await claim(AGENT_A, TTL_A_MS);
    expect(claimA.claim).toMatchObject({
      repo: REPO, task: TASK, agent: AGENT_A, claimedAt: t0, expiresAt: t0 + TTL_A_MS,
    });

    // One millisecond before expiry the advisory claim is still live on a fresh board read.
    at(TTL_A_MS - 1);
    const before = await board();
    expect(before.code).toBe(0);
    expect(before.json.claims).toEqual([expect.objectContaining({ id: claimA.claim.id, agent: AGENT_A })]);
    expect(before.json.expiredClaims).toBe(0);

    // At the exact expiry instant the board read itself reaps the lease and records it.
    at(TTL_A_MS);
    const reaped = await board();
    expect(reaped.code).toBe(0);
    expect(reaped.json).toMatchObject({ state: 'known', claims: [], expiredClaims: 1 });
    expect(ledgerEvents().filter(event => event['kind'] === 'reap')).toEqual([
      expect.objectContaining({ id: claimA.claim.id, owner: AGENT_A, state: 'RELEASED', reason: 'lease-expired', at: t0 + TTL_A_MS }),
    ]);

    // A successor acquires the identical repo/task one millisecond past expiry.
    at(TTL_A_MS + 1);
    const claimB = await claim(AGENT_B, TTL_B_MS);
    expect(claimB.claim.id).not.toBe(claimA.claim.id);
    expect(claimB.lease).not.toBe(claimA.lease);
    expect(claimB.claim).toMatchObject({
      repo: REPO, task: TASK, agent: AGENT_B, claimedAt: t0 + TTL_A_MS + 1, expiresAt: t0 + TTL_A_MS + 1 + TTL_B_MS,
    });

    const live = await board();
    expect(live.code).toBe(0);
    expect(live.json.claims).toEqual([expect.objectContaining({
      id: claimB.claim.id, repo: REPO, task: TASK, agent: AGENT_B,
    })]);
    expect(live.json.claims.map((claim: any) => claim.id)).not.toContain(claimA.claim.id);

    // A's old receipt can neither release nor return its expired claim.
    expect(await release(claimA.claim.id, AGENT_A, claimA.lease))
      .toMatchObject({ code: 1, json: { ok: false, error: 'not-found' } });
    expect(await ret(claimA.claim.id, AGENT_A, claimA.lease, ['--blocked', 'upstream review claim']))
      .toMatchObject({ code: 1, json: { ok: false, outcome: 'not-found' } });
    // The VERIFIED evidence form is fenced the same way; nothing is posted.
    expect(await ret(claimA.claim.id, AGENT_A, claimA.lease, ['--pr', '379', '--head', SYNTHETIC_HEAD]))
      .toMatchObject({ code: 1, json: { ok: false, outcome: 'not-found' } });

    // A's stale credentials cannot touch the replacement owner's live claim.
    expect(await release(claimB.claim.id, AGENT_A, claimA.lease))
      .toMatchObject({ code: 1, json: { ok: false, error: 'not-owner' } });
    expect(await ret(claimB.claim.id, AGENT_A, claimA.lease, ['--blocked', 'upstream review claim']))
      .toMatchObject({ code: 1, json: { ok: false, outcome: 'not-owner' } });
    // B's agent label alone does not help without B's lease.
    expect(await release(claimB.claim.id, AGENT_B, claimA.lease))
      .toMatchObject({ code: 1, json: { ok: false, error: 'not-owner' } });
    expect(await ret(claimB.claim.id, AGENT_B, claimA.lease, ['--tests', 'passed']))
      .toMatchObject({ code: 1, json: { ok: false, outcome: 'not-owner' } });

    // No receipt exists for the replacement claim and nothing reports VERIFIED.
    const receipts = await returns();
    expect(receipts.code).toBe(0);
    expect(receipts.json).toMatchObject({ state: 'known', returns: [], unparsed: 0 });

    // A fresh board read from disk still shows B's live claim untouched.
    const stillLive = await board();
    expect(stillLive.code).toBe(0);
    expect(stillLive.json.claims).toEqual([expect.objectContaining({
      id: claimB.claim.id, repo: REPO, task: TASK, agent: AGENT_B,
    })]);
    expect(stillLive.json.expiredClaims).toBe(0);

    // The real owner returns its own blocked dependency.
    expect(await ret(claimB.claim.id, AGENT_B, claimB.lease, ['--blocked', 'waiting on upstream coordination claim']))
      .toMatchObject({ code: 0, json: { ok: true, outcome: 'returned', claimId: claimB.claim.id } });
    expect(await ret(claimB.claim.id, AGENT_B, claimB.lease, ['--blocked', 'waiting on upstream coordination claim']))
      .toMatchObject({ code: 0, json: { ok: true, outcome: 'already-returned', claimId: claimB.claim.id } });

    const finalBoard = await board();
    expect(finalBoard.code).toBe(0);
    expect(finalBoard.json).toMatchObject({ state: 'known', claims: [], expiredClaims: 0 });
    expect(finalBoard.json.messages).toEqual([expect.objectContaining({
      id: `return-${claimB.claim.id}`, from: AGENT_B, to: 'all',
    })]);

    const finalReturns = await returns();
    expect(finalReturns.code).toBe(0);
    expect(finalReturns.json).toMatchObject({ state: 'known', unparsed: 0 });
    expect(finalReturns.json.returns).toEqual([expect.objectContaining({
      claimId: claimB.claim.id, repo: REPO, result: 'BLOCKED', evidenceKind: 'dependency',
      pr: null, head: null, from: AGENT_B,
    })]);
    expect(finalReturns.json.returns[0].evidence).toContain('waiting on upstream coordination claim');

    // Board and returns never expose a lease or leaseHash.
    for (const text of [before.text, reaped.text, live.text, receipts.text, stillLive.text, finalBoard.text, finalReturns.text]) {
      expectNoLeaseMaterial(text, [claimA.lease, claimB.lease]);
    }

    // The durable ledger proves the lifecycle: claim, reap, claim, release, post.
    const events = ledgerEvents();
    expect(events.map(event => event['kind'])).toEqual(['claim', 'reap', 'claim', 'release', 'post']);
    expect(events[0]).toMatchObject({ kind: 'claim', claim: { id: claimA.claim.id, agent: AGENT_A, repo: REPO, task: TASK } });
    expect(events[1]).toMatchObject({ kind: 'reap', id: claimA.claim.id, owner: AGENT_A, state: 'RELEASED', reason: 'lease-expired', at: t0 + TTL_A_MS });
    expect(events[2]).toMatchObject({ kind: 'claim', claim: { id: claimB.claim.id, agent: AGENT_B, repo: REPO, task: TASK } });
    expect(events[3]).toMatchObject({ kind: 'release', id: claimB.claim.id });
    expect(events[4]).toMatchObject({ kind: 'post', message: { id: `return-${claimB.claim.id}`, from: AGENT_B, to: 'all' } });
    const raw = readFileSync(ledgerPath, 'utf8');
    expect(raw).not.toContain(claimA.lease);
    expect(raw).not.toContain(claimB.lease);
    expect((events[0]!['claim'] as any).leaseHash).toMatch(/^[a-f0-9]{64}$/);
    expect((events[2]!['claim'] as any).leaseHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reaps and re-claims atomically when a successor claims at the exact expiry instant', async () => {
    at(0);
    const claimA = await claim(AGENT_A, TTL_A_MS);

    // No board read in between: the claim mutation itself reaps at expiresAt <= now.
    at(TTL_A_MS);
    const claimB = await claim(AGENT_B, TTL_B_MS);
    expect(claimB.claim.id).not.toBe(claimA.claim.id);
    expect(claimB.lease).not.toBe(claimA.lease);

    const live = await board();
    expect(live.code).toBe(0);
    expect(live.json.claims).toEqual([expect.objectContaining({ id: claimB.claim.id, agent: AGENT_B })]);
    expect(live.json.expiredClaims).toBe(0);

    // The expired owner remains fenced on both verbs after the atomic reap.
    expect(await release(claimA.claim.id, AGENT_A, claimA.lease))
      .toMatchObject({ code: 1, json: { ok: false, error: 'not-found' } });
    expect(await ret(claimA.claim.id, AGENT_A, claimA.lease, ['--blocked', 'upstream review claim']))
      .toMatchObject({ code: 1, json: { ok: false, outcome: 'not-found' } });
    expect(await returns()).toMatchObject({ code: 0, json: { state: 'known', returns: [] } });

    // The replacement owner can still complete its own blocked return.
    expect(await ret(claimB.claim.id, AGENT_B, claimB.lease, ['--blocked', 'waiting on upstream coordination claim']))
      .toMatchObject({ code: 0, json: { ok: true, outcome: 'returned', claimId: claimB.claim.id } });
    const finalReturns = await returns();
    expect(finalReturns.json.returns).toEqual([expect.objectContaining({
      claimId: claimB.claim.id, repo: REPO, result: 'BLOCKED', evidenceKind: 'dependency', from: AGENT_B,
    })]);
    const events = ledgerEvents();
    expect(events.map(event => event['kind'])).toEqual(['claim', 'reap', 'claim', 'release', 'post']);
    expect(events[1]).toMatchObject({ kind: 'reap', id: claimA.claim.id, owner: AGENT_A, reason: 'lease-expired', at: t0 + TTL_A_MS });
    const raw = readFileSync(ledgerPath, 'utf8');
    expect(raw).not.toContain(claimA.lease);
    expect(raw).not.toContain(claimB.lease);
  });
});
