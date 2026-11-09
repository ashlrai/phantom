import { performance } from 'node:perf_hooks';
import { buildResourceView } from './fabric/resource-view.js';
import { routeSeat } from './routing/router.js';
import { defaultBudgetPolicy } from './routing/policy.js';
import { DriveNodes, type NodesStore, type NodesState } from './drive/nodes/index.js';
import { emptyState } from './drive/nodes/state.js';
import { requestBusRoundtrip } from './fleet/bus-request-roundtrip.js';
import { scatterBusRequests } from './fleet/bus-scatter-request.js';
import { createChannelReceiver } from './fleet/channel-envelope.js';
import type { BusEnvelope } from './fleet/bus-envelope.js';

export interface ChainLink { link: string; status: 'pass' | 'fail' | 'blocked'; latencyMs: number | null }
export interface ChainReport { schema: 'phantom.chain.verify.v1'; scope: 'synthetic'; status: 'pass' | 'fail'; links: ChainLink[] }

/** No host state, credentials, transport, or persistent store is used. */
export async function verifyChain(): Promise<ChainReport> {
  const links: ChainLink[] = [];
  let previous = true;
  async function probe(link: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    if (!previous) { links.push({ link, status: 'blocked', latencyMs: null }); return; }
    const start = performance.now();
    let ok = false;
    try { ok = await fn(); } catch { /* Value-blind: never expose exception contents. */ }
    links.push({ link, status: ok ? 'pass' : 'fail', latencyMs: Math.max(0, performance.now() - start) });
    previous = ok;
  }
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  let used: number | null = null;
  await probe('resource-bars', () => {
    const view = buildResourceView({ readings: { 'grok-ultra': { pool: 'grok-ultra', source: 'grok-reader', fetchedAt: new Date(now).toISOString(), pctUsed: 25 } } }, now);
    used = view.pools.find(p => p.pool === 'grok-ultra')?.pctUsed ?? null;
    return used === 25 && buildResourceView({}, now).pools.every(p => p.pctUsed === null);
  });
  let selected: string | null = null;
  await probe('model-router', () => {
    const seat = { seatId: 'grok-ultra', label: 'synthetic', engine: 'grok' as const, free: false, signedOut: false, reachable: true,
      contextWindow: 200000, observedAt: new Date(now).toISOString(), spentTodayUsd: null,
      windows: [{ id: 'grok_unified_weekly', usedPercent: used, limitReached: false, resetsAt: null, resetDescription: null }] };
    selected = routeSeat({ task: 'code', difficulty: 'medium', autonomous: false }, [seat], defaultBudgetPolicy(), { nowMs: now }).seatId;
    return selected === 'grok-ultra';
  });
  let targets: string[] = [];
  await probe('load-balancer', () => {
    let state = emptyState();
    const store: NodesStore = { transaction<T>(fn: (draft: NodesState) => T): T { const draft = structuredClone(state); const result = fn(draft); state = draft; return result; } };
    const nodes = new DriveNodes(store, { now: () => now });
    nodes.join('a', { owners: ['synthetic'], caps: [selected!] });
    nodes.join('b', { owners: ['synthetic'], caps: [selected!] });
    nodes.enqueue('one', { owner: 'synthetic', requires: [selected!] });
    nodes.enqueue('two', { owner: 'synthetic', requires: [selected!] });
    targets = nodes.plan().map(row => row.nodeId ?? '');
    return targets.join(',') === 'a,b';
  });
  const envelope = (id: string, to: string): BusEnvelope => ({ id, from: 'leader', to, priority: 'P2', ttl: 10000, body: { probe: true } });
  await probe('agent-messaging', async () => {
    const request = envelope('probe', targets[0]!);
    let posted = false;
    const result = await requestBusRoundtrip(request, 1000, 100, {}, {
      list: (cursor) => ({ status: 'ok', nextCursor: posted ? 1 : 0, messages: posted && cursor === 0 ? [{ cursor: 1, envelope: { ...envelope('reply', 'leader'), from: request.to, body: { inReplyTo: request.id } }, receivedAt: now }] : [] }),
      append: () => { posted = true; return { status: 'posted', id: request.id, cursor: 1 }; },
    });
    return result.outcome === 'replied';
  });
  await probe('parallel-orchestration', async () => {
    let active = 0, peak = 0;
    const result = await scatterBusRequests(targets.map((to, i) => envelope(`parallel-${i}`, to)), 1000, 2, {}, {
      request: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return { schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only', receipt: { status: 'not-attempted' }, outcome: 'replied', reply: null, cursor: 0, elapsedMs: 0 }; },
    });
    return result.status === 'all-replied' && peak === 2;
  });
  await probe('leader-human-comms', async () => {
    let written = false, acked = false;
    const receive = createChannelReceiver({ allowedSenderIds: new Set(['synthetic-human']), publish: null,
      write: async () => { written = true; return { ok: true, at: 'synthetic', bytes: 1, id: 'synthetic' }; },
      acknowledge: async ack => { acked = written && ack.status === 'accepted'; } });
    const result = await receive({ channel: 'cli', verifiedSenderId: 'synthetic-human', body: 'synthetic probe' });
    const denied = await receive({ channel: 'cli', verifiedSenderId: 'stranger', body: 'synthetic probe' });
    return result.ok && acked && !denied.ok && denied.reason === 'sender-not-allowed';
  });
  return { schema: 'phantom.chain.verify.v1', scope: 'synthetic', status: links.every(l => l.status === 'pass') ? 'pass' : 'fail', links };
}
