import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proposeAgent, readAgentPlane, syncAgentPlane, orgBoardView } from '../src/core/org/agent-plane.js';
import { type OrgAgent, type OrgProposal, initialPlane } from '../src/core/org/agent-plane-schema.js';
import { sizeWorkerSession } from '../src/core/org/session-economics.js';
import { busBodySchema, claimKeysOverlap } from '../src/core/agents/bus-v2-schema.js';
import { acquireCoordination, listCoordination } from '../src/core/agents/claim-store.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { cmdOrg } from '../src/cli/org.js';
import * as gates from '../src/core/agents/send-gate.js';

let root: string;
const worker = (): OrgAgent => ({ ...initialPlane().agents[1]!, id: 'worker', tier: 'WORKER_SESSION', reportsTo: 'engineering', needs: ['git', 'python'], laneAffinities: ['future-lane'], sessionId: 'sesn_fixture' });
const propose = (change: OrgProposal['change'], apply = true, actor = 'leader', revision = readAgentPlane(root).revision) =>
  proposeAgent({ actor, reason: 'Measured useful work', expectedRevision: revision, change }, apply, root, join(root, 'bus'));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'org-plane-')); vi.spyOn(gates, 'localWriteGate').mockReturnValue(null); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('org plane', () => {
  it('lists standing roles without writing and rejects invalid reads', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdOrg(['agents', '--runs', root, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0])).agents.map((role: OrgAgent) => role.id)).toEqual(['leader', 'engineering', 'janitor', 'comms']);
    expect(() => statSync(join(root, 'org'))).toThrow();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdOrg(['agents', 'missing', '--runs', root, '--json'])).toBe(1);
    expect(await cmdOrg(['agents', '--apply', '--runs', root])).toBe(1);
  });
  it('applies CLI proposals to a scratch chart and scratch bus only', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const input = join(root, 'proposal.json');
    writeFileSync(input, JSON.stringify({ actor: 'board', reason: 'Staff review', expectedRevision: 0, change: { kind: 'upsert', role: worker() } }));
    expect(await cmdOrg(['propose', '--input', input, '--apply', '--runs', root, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0])).revision).toBe(1);
    expect(listBusInboxAfter(0, 100, { root: join(root, 'bus') }).status).toBe('ok');
    expect(readAgentPlane(root).agents).toHaveLength(5);
  });
  it('separates proposals, creates workers, detects stale revisions and reverses edits', () => {
    expect(propose({ kind: 'upsert', role: worker() }, false).agents).toHaveLength(4);
    let plane = propose({ kind: 'upsert', role: worker() }, true, 'engineering');
    expect(plane.agents).toHaveLength(5);
    expect(plane.ledger.map(row => row.applied)).toEqual([false, true]);
    expect(() => propose({ kind: 'retire', id: 'worker' }, true, 'leader', 0)).toThrow(/revision/);
    plane = propose({ kind: 'revoke', revision: 2 });
    expect(plane.agents).toHaveLength(4);
    expect(readAgentPlane(root)).toEqual(plane);
    expect(statSync(join(root, 'org', 'agents.json')).mode & 0o777).toBe(0o600);
    expect(orgBoardView(plane).grantsExecutionAuthority).toBe(false);
  });
  it('retitles and re-scopes, drains organizational children on retirement, and refuses stale undo', () => {
    propose({ kind: 'upsert', role: worker() });
    propose({ kind: 'upsert', role: { ...worker(), title: 'Review worker', sizing: { batchDepth: 200, fanOut: 4 } } });
    expect(() => propose({ kind: 'revoke', revision: 1 })).toThrow(/changed since/);
    const plane = propose({ kind: 'retire', id: 'engineering' });
    expect(plane.agents.filter(role => role.status === 'retired').map(role => role.id)).toEqual(['engineering', 'worker']);
    expect(() => propose({ kind: 'retire', id: 'leader' })).toThrow(/leader/);
  });
  it('bounds scope, budgets, hierarchy, worker authority and orchestrator domains', () => {
    for (const patch of [{ id: 'worker\n' }, { needs: ['git\n'] }, { scope: 'payments' }, { needs: ['secrets:HANDLE'] }, { needs: ['payment'] }, { credentials: [] }, { reportsTo: 'worker' },
      { budget: { tokens: 1, sessions: 0, maxCostClass: 'included' } }, { sizing: { batchDepth: 1, fanOut: 99 } }]) {
      expect(() => propose({ kind: 'upsert', role: { ...worker(), ...patch } as OrgAgent })).toThrow();
    }
    expect(() => propose({ kind: 'upsert', role: { ...worker(), reportsTo: 'comms' } }, true, 'engineering')).toThrow(/Orchestrators/);
    propose({ kind: 'upsert', role: worker() });
    expect(() => propose({ kind: 'retire', id: 'worker' }, true, 'worker')).toThrow(/Proposals require/);
    expect(() => propose({ kind: 'upsert', role: { ...worker(), id: 'second' } })).toThrow(/already staffed/);
    vi.mocked(gates.localWriteGate).mockReturnValue({ status: 'refused', reason: 'Killed' });
    expect(() => propose({ kind: 'retire', id: 'worker' })).toThrow(/paused or killed/);
    expect(readAgentPlane(root).revision).toBe(1);
  });
  it('refuses corrupt or symlinked storage without replacing it', () => {
    propose({ kind: 'upsert', role: worker() });
    const file = join(root, 'org', 'agents.json');
    writeFileSync(file, '{broken');
    expect(() => syncAgentPlane(root)).toThrow(/Invalid org/);
    expect(readFileSync(file, 'utf8')).toBe('{broken');
    rmSync(file); symlinkSync(join(root, 'outside'), file);
    expect(() => syncAgentPlane(root)).toThrow(/unavailable/);
  });
  it('enforces aggregate ceilings after allocating positive planning budgets', () => {
    const budget = { tokens: 1000, sessions: 2, maxCostClass: 'included' as const };
    for (const id of ['leader', 'engineering']) propose({ kind: 'upsert', role: { ...readAgentPlane(root).agents.find(role => role.id === id)!, budget } });
    propose({ kind: 'upsert', role: { ...worker(), budget: { ...budget, tokens: 600, sessions: 1 } } });
    expect(() => propose({ kind: 'upsert', role: { ...worker(), id: 'second', sessionId: null, budget: { ...budget, tokens: 600, sessions: 1 } } })).toThrow(/ceil/);
    expect(() => propose({ kind: 'upsert', role: { ...worker(), charter: 'sk-' + 'x'.repeat(24) } })).toThrow(/Secret-shaped/);
    expect(readAgentPlane(root).revision).toBe(3);
  });
  it('publishes membership through the bus and persists retryable delivery without duplicate edits', () => {
    const blockedBus = join(root, 'blocked'); writeFileSync(blockedBus, 'blocked');
    const input = { actor: 'board', reason: 'Staff review', expectedRevision: 0, change: { kind: 'upsert', role: worker() } };
    expect(proposeAgent(input, true, root, blockedBus).ledger[0]!.busDelivered).toBe(false);
    const busRoot = join(root, 'bus');
    expect(syncAgentPlane(root, busRoot).ledger[0]!.busDelivered).toBe(true);
    expect(syncAgentPlane(root, busRoot).revision).toBe(1);
    const inbox = listBusInboxAfter(0, 100, { root: busRoot });
    expect(inbox.status).toBe('ok');
    if (inbox.status !== 'ok') throw new Error('Expected inbox');
    expect(inbox.messages).toHaveLength(1);
    expect(busBodySchema.parse(inbox.messages[0]!.envelope.body)).toMatchObject({ kind: 'org.membership', roleId: 'worker', claimKey: 'org:worker', grantsExecutionAuthority: false });
    expect(claimKeysOverlap('org:worker', 'repo:a/b')).toBe(false);
    const request = { root, origin: 'resource' as const, key: 'org:worker', owner: 'session-a', sourceId: 'session-a', leaseMs: 100, leaseUntil: 200, now: 100 };
    expect(acquireCoordination(request).status).toBe('acquired');
    expect(acquireCoordination({ ...request, owner: 'session-b', sourceId: 'session-b' }).status).toBe('conflict');
    expect(listCoordination(root, 201).claims.filter(claim => claim.live)).toHaveLength(0);
  });
});

describe('session unit economics', () => {
  const sample = { batchDepth: 100, fanOut: 2, completed: 100, tokens: 1000, elapsedMs: 1000, setupTokens: 200 };
  const vitals = { queued: 100, liveClaims: 0, tokenCeiling: 10_000, fanOutCeiling: 4, warm: sample, fresh: [sample] };
  it('amortizes warm sessions and prefers a measured cheaper fresh configuration when useful', () => {
    expect(sizeWorkerSession(vitals).action).toBe('keep');
    expect(sizeWorkerSession({ ...vitals, fresh: [{ ...sample, tokens: 500 }] })).toMatchObject({ action: 'spawn', sizing: { batchDepth: 100, tokensPerTask: 7 } });
    expect(sizeWorkerSession({ ...vitals, queued: 1, fresh: [{ ...sample, tokens: 500 }] }).action).toBe('keep');
  });
  it('drains live work, retires idle sessions, and holds unknown or unaffordable capacity', () => {
    expect(sizeWorkerSession({ ...vitals, queued: 0, liveClaims: 1 }).action).toBe('drain');
    expect(sizeWorkerSession({ ...vitals, queued: 0 }).action).toBe('retire');
    expect(sizeWorkerSession({ ...vitals, liveClaims: 1, fresh: [{ ...sample, tokens: 500 }] }).action).toBe('drain');
    expect(sizeWorkerSession({ ...vitals, warm: null, fresh: [] }).action).toBe('hold');
    expect(sizeWorkerSession({ ...vitals, tokenCeiling: 1 }).action).toBe('hold');
    expect(() => sizeWorkerSession({ ...vitals, queued: -1 })).toThrow();
  });
});
