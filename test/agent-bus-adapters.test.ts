import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { createBusChannelAdapter, deliverLocalEnvelope, probeBusChannel, readChannel } from '../src/core/agents/adapters/bus.js';
import { probeHandoffChannel } from '../src/core/agents/adapters/handoff.js';
import { listChannelRegistry, probeRegisteredChannel, resetChannelRegistryForTests } from '../src/core/agents/channel-registry.js';
import {
  acquireCoordination, claimBoard, listCoordination, setWorkStatus,
} from '../src/core/agents/claim-store.js';
import { sendProviderBridge } from '../src/core/agents/bridges/dispatch.js';
import { codexQueueArgs } from '../src/core/agents/bridges/codex.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { killSwitchPath } from '../src/core/sandbox/policy.js';
import { setPause } from '../src/core/comms/pause.js';
import { acquireClaim, releaseClaim } from '../src/core/teams/state.js';
import type { TeamIdentity } from '../src/core/agents/channel-policy.js';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bus-adapters-'));
  roots.push(root);
  return root;
};
const team: TeamIdentity[] = [{ channel: 'bus', id: 'agent-codex' }];
const allowed = { teamIdentities: team, confirmedByMason: true, external: false as const };
afterEach(() => {
  resetChannelRegistryForTests();
  setPause(false);
  rmSync(killSwitchPath(), { force: true });
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

describe('channel adapter registry', () => {
  it('reports bus and handoff as registered and probes them into a temp store', async () => {
    const root = temp();
    const listed = listChannelRegistry();
    expect(listed.map(row => row.id)).toEqual(['bus', 'slack', 'imessage', 'email', 'telegram', 'handoff']);
    expect(listed.filter(row => row.adapterRegistered).map(row => row.id)).toEqual(['bus', 'handoff']);
    expect(listed.find(row => row.id === 'email')).toMatchObject({ adapterRegistered: false, healthy: false });
    const bus = await probeRegisteredChannel('bus', { root });
    const handoff = await probeHandoffChannel({ root });
    expect(bus).toMatchObject({ dryRun: false, status: 'sent' });
    expect(handoff.status).toBe('sent');
    const seen: string[] = [];
    for await (const message of readChannel('bus', { root })) seen.push(message.channel ?? 'bus');
    expect(seen).toContain('bus');
    const out: string[] = [];
    const code = await runAgentsCli(['bus', 'channels', 'test', 'bus', '--root', root, '--json'], line => out.push(line));
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ id: 'bus', dryRun: false, status: 'sent' });
  });

  it('measures a local bus round trip under 2 seconds at p95', async () => {
    const root = temp();
    const adapter = createBusChannelAdapter({ root });
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const envelope = {
        id: `rt-${i}`, from: 'local-probe', to: 'local-probe', priority: 'P3' as const, ttl: 60_000,
        body: { kind: 'note', text: 'round trip' }, channel: 'bus' as const, channel_ref: 'local-probe',
        sender: { agent_id: 'local-probe', vendor: 'phantom', human: false, team: true },
        external: false, origin_bridge: 'channel-probe',
      };
      const started = performance.now();
      const sent = await deliverLocalEnvelope(envelope, 'bus', { root, enforcePolicy: false });
      let found = false;
      for await (const message of adapter.ingest()) {
        if (message.id === envelope.id) found = true;
      }
      samples.push(performance.now() - started);
      expect(sent.status).toBe('sent');
      expect(found).toBe(true);
    }
    expect((await adapter.deliver({
      id: 'policy-blocked', from: 'local-probe', to: 'local-probe', priority: 'P3', ttl: 60_000,
      body: { kind: 'note', text: 'round trip' }, channel: 'bus', channel_ref: 'local-probe',
      sender: { agent_id: 'local-probe', vendor: 'phantom', human: false, team: true },
      external: false, origin_bridge: 'channel-probe',
    })).status).toBe('refused');
    const measured = p95(samples);
    console.log(`local bus round trip p95 ${measured.toFixed(2)} ms`);
    expect(measured).toBeLessThan(2_000);
  });

  it('refuses a probe while the kill switch or communications pause is on', async () => {
    const root = temp();
    mkdirSync(join(killSwitchPath(), '..'), { recursive: true });
    writeFileSync(killSwitchPath(), 'on\n', { mode: 0o600 });
    expect((await probeBusChannel({ root })).status).toBe('refused');
    rmSync(killSwitchPath(), { force: true });
    setPause(true);
    expect((await probeHandoffChannel({ root })).reason).toBe('Communications are paused.');
  });
});

describe('provider bridges', () => {
  it('builds the codex queue command and sends only after the gate', async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: readonly string[]) => { calls.push([...args]); return { code: 0 }; };
    expect(codexQueueArgs('thread-1', 'hello')).toEqual(['queue', '--thread', 'thread-1', '--message', 'hello']);
    const sent = await sendProviderBridge({
      provider: 'codex', recipientId: 'agent-codex', text: 'hello', threadId: 'thread-1', ...allowed,
    }, { exec });
    expect(sent).toMatchObject({ status: 'sent' });
    expect(calls).toEqual([['queue', '--thread', 'thread-1', '--message', 'hello']]);
    calls.length = 0;
    const drafted = await sendProviderBridge({
      provider: 'codex', recipientId: 'agent-codex', text: 'hello', threadId: 'thread-1',
      teamIdentities: team, confirmedByMason: false,
    }, { exec });
    expect(drafted.status).toBe('drafted');
    expect(calls).toEqual([]);
    const refused = await sendProviderBridge({
      provider: 'codex', recipientId: 'someone-else', text: 'hello', threadId: 'thread-1', ...allowed,
    }, { exec });
    expect(refused.status).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('calls the Devin REST client or the tracked task sender and stubs the others', async () => {
    const rest: string[] = [];
    const tracked: string[] = [];
    const client = { sendMessage: async (orgId: string, sessionId: string, message: string) => { rest.push(`${orgId}:${sessionId}:${message}`); } };
    const sent = await sendProviderBridge({
      provider: 'devin', recipientId: 'agent-codex', text: 'ping', orgId: 'org-acme', sessionId: 'devin-session', ...allowed,
    }, { client });
    expect(sent.status).toBe('sent');
    expect(rest).toEqual(['org-acme:devin-session:ping']);
    const task = await sendProviderBridge({
      provider: 'devin', recipientId: 'agent-codex', text: 'ping', taskId: 'task-1', ...allowed,
    }, { sendTracked: async (taskId, text) => { tracked.push(`${taskId}:${text}`); return { ok: true }; } });
    expect(task.status).toBe('sent');
    expect(tracked).toEqual(['task-1:ping']);
    expect((await sendProviderBridge({ provider: 'devin', recipientId: 'agent-codex', text: 'ping', ...allowed })).status).toBe('refused');
    expect((await sendProviderBridge({ provider: 'grok', recipientId: 'agent-codex', text: 'ping', ...allowed })).reason).toContain('grok');
    expect((await sendProviderBridge({ provider: 'claude', recipientId: 'agent-codex', text: 'ping', ...allowed })).reason).toContain('claude');
    const secret = `ghp_${'a'.repeat(36)}`;
    const exec = async () => { throw new Error('must not send'); };
    expect((await sendProviderBridge({
      provider: 'codex', recipientId: 'agent-codex', text: secret, threadId: 'thread-1', ...allowed,
    }, { exec })).status).toBe('refused');
  });

  it('does not call an executor while paused', async () => {
    setPause(true);
    let called = false;
    const result = await sendProviderBridge({
      provider: 'codex', recipientId: 'agent-codex', text: 'hello', threadId: 'thread-1', ...allowed,
    }, { exec: async () => { called = true; return { code: 0 }; } });
    expect(result.reason).toBe('Communications are paused.');
    expect(called).toBe(false);
  });
});

describe('coordination claim store', () => {
  it('is the overlap authority for message claims and team leases', () => {
    const root = temp();
    expect(appendBusInbox({ id: 'message', from: 'fake', to: 'shared', priority: 'P1', ttl: 10_000, body: 'body' }, { root }).status).toBe('posted');
    const acquired = mutateBusWorkClaim({ action: 'acquire', id: 'message', owner: 'worker', leaseMs: 1_000, root });
    expect(acquired.status).toBe('acquired');
    expect(listCoordination(root).claims.filter(row => row.live).map(row => row.key)).toEqual(['queue:message']);
    expect(acquireCoordination({
      root, origin: 'resource', key: 'queue:message', owner: 'other', leaseMs: 1_000,
      leaseUntil: Date.now() + 1_000, sourceId: 'resource-1',
    }).status).toBe('conflict');
    expect(mutateBusWorkClaim({ action: 'release', id: 'message', token: acquired.token, root }).status).toBe('released');
    expect(listCoordination(root).claims.filter(row => row.live)).toEqual([]);

    const actor = { kind: 'agent' as const, id: 'agent:codex/adapters', provider: 'codex' };
    const other = { kind: 'agent' as const, id: 'agent:grok/adapters', provider: 'grok' };
    const teamName = `adapters-${Date.now().toString(36)}`;
    const first = acquireClaim(teamName, actor, { repo: 'example/adapters', branch: 'feat/x' }, 'feature');
    const second = acquireClaim(teamName, other, { repo: 'example/adapters', branch: 'feat/y' }, 'other');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const blocked = acquireCoordination({
      origin: 'resource', key: 'repo:example/adapters', owner: 'other-worker', leaseMs: 60_000,
      leaseUntil: Date.now() + 60_000, sourceId: 'repo-1',
    });
    expect(blocked.status).toBe('conflict');
    if (first.ok) releaseClaim(teamName, actor, first.claimId);
    if (second.ok) releaseClaim(teamName, other, second.claimId);
    const status = setWorkStatus({
      root, jobId: 'job-1', owner: 'worker', provider: 'devin', repo: 'example/adapters',
      claimKeys: ['repo:example/adapters'], status: 'running',
    });
    expect(status.status).toBe('acquired');
    const board = claimBoard({
      root, queued: new Map([['src/a.ts', ['RQ-PHX-ABC']]]), repo: 'example/adapters',
    });
    expect(board.statuses.map(row => row.jobId)).toEqual(['job-1']);
    expect(board.observations.map(row => row.key)).toEqual(['path:example/adapters:src/a.ts']);
    expect(board.claims.map(row => row.origin)).not.toContain('queue');
  });
});
