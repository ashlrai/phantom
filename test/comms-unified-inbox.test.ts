/**
 * Unified comms inbox (`phm comms inbox [--json]`): aggregates unresolved
 * needs-you lines, unanswered teammate texts, owner-thread messages awaiting
 * a recorded reply, pending drafts and unclaimed bus work into one prioritized
 * list with deep links. Hermetic: every store lives under a temp dir; no
 * network, no model calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDraft } from '../src/core/cos/drafts.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { emptyOwnerSettings, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, postOwnerNotice, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { readUnifiedInbox, UNIFIED_INBOX_MAX_ITEMS, type UnifiedInbox } from '../src/core/comms/unified-inbox.js';
import { markTeammateTextsAnswered, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { AgentConversations } from '../src/core/fleet/agent-conversations.js';
import type { BusJsonValue } from '../src/core/fleet/bus-envelope.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';

let root: string, runsDir: string, busRoot: string, now: number;
const roots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unified-inbox-')); roots.push(root);
  runsDir = join(root, 'runs'); mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  busRoot = join(root, 'bus'); mkdirSync(busRoot, { recursive: true, mode: 0o700 });
  now = Date.parse('2026-11-07T12:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const read = (): Promise<UnifiedInbox> => readUnifiedInbox({ runsDir, busRoot, now: () => now });

function postWork(id: string, extra: { priority?: 'P0' | 'P1' | 'P2' | 'P3'; ttl?: number; kind?: string; at?: number } = {}) {
  const receipt = appendBusInbox({
    id, from: 'leader', to: 'worker', priority: extra.priority ?? 'P2',
    ttl: extra.ttl ?? 48 * 3_600_000, body: extra.kind === 'note' ? { kind: 'note', text: 'fake note' } : { kind: 'work', text: `fake work ${id}` },
  }, { root: busRoot, now: () => extra.at ?? now });
  expect(receipt.status).toBe('posted');
  return receipt;
}
/** Write a valid v2 inbox snapshot directly: each append rewrites the whole store, so bulk setup would take tens of seconds. */
function postWorkSnapshot(ids: string[]) {
  mkdirSync(join(busRoot, 'bus-inbox'), { recursive: true, mode: 0o700 });
  const rows = ids.map((id, i) => ({
    cursor: i + 1, receivedAt: now - i * 1000,
    envelope: { id, from: 'leader', to: 'worker', priority: 'P2', ttl: 48 * 3_600_000, body: { kind: 'work', text: `fake work ${id}` } },
  }));
  writeFileSync(join(busRoot, 'bus-inbox', 'messages.json'), JSON.stringify({ version: 2, highWater: ids.length, rows }), { mode: 0o600 });
}
function claim(id: string, leaseMs = 600_000, owner = 'worker') {
  const result = mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs, root: busRoot });
  expect(result.status).toBe('acquired');
  return result;
}

let v2seq = 0;
function postV2Body(body: BusJsonValue, extra: { priority?: 'P0' | 'P1' | 'P2' | 'P3'; ttl?: number; at?: number; from?: string; to?: string } = {}) {
  v2seq += 1;
  const id = `v2-${v2seq}`;
  const receipt = appendBusInbox({
    id, from: extra.from ?? 'agent:peer', to: extra.to ?? 'leaders',
    priority: extra.priority ?? 'P2', ttl: extra.ttl ?? 7 * 24 * 3_600_000, body,
  }, { root: busRoot, now: () => extra.at ?? now });
  expect(receipt.status).toBe('posted');
  return id;
}
function postJob(jobId: string, over: { title?: string; claimKeys?: string[]; provider?: string; priority?: 'P0' | 'P1' | 'P2' | 'P3'; ttl?: number; at?: number } = {}) {
  postV2Body({ kind: 'work.post', jobId, title: over.title ?? `fake job ${jobId}`,
    provider: over.provider ?? 'codex-cmp', repo: 'ashlrai/phantom',
    claimKeys: over.claimKeys ?? [`queue:${jobId}`] }, over);
}
function postStatus(jobId: string, status: string, from = 'agent:peer') {
  postV2Body({ kind: 'work.status', jobId, status }, { from });
}
function holdKey(key: string, owner = 'worker') {
  const result = acquireCoordination({ root: busRoot, origin: 'resource', key, owner,
    leaseMs: 600_000, leaseUntil: now + 600_000, sourceId: `test:${key}`, now });
  expect(result.status).toBe('acquired');
}

describe('readUnifiedInbox sources', () => {
  it('reports empty stores with per-source state', async () => {
    const inbox = await read();
    expect(inbox).toMatchObject({
      v: 1, total: 0, omitted: 0, items: [],
      sources: {
        'needs-you': { state: 'missing', pending: 0 },
        imessage: { state: 'missing', pending: 0 },
        drafts: { state: 'healthy', pending: 0 },
        bus: { state: 'missing', pending: 0 },
        conversations: { state: 'missing', pending: 0 },
      },
    });
  });

  it('lists unresolved needs-you lines as blocking warn items with resolve links', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- restart the worker pool on mac-2\n- second fake item\n');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'needs-you');
    expect(items).toHaveLength(2);
    const restart = items.find(i => i.title === 'restart the worker pool on mac-2')!;
    expect(restart).toMatchObject({
      kind: 'needs-you', severity: 'warn', blocking: true, priority: 'now',
      act: [expect.stringMatching(/^phm fleet needs-resolve nm-[0-9a-f]{12} --reply "<reply>"$/)],
    });
    expect(restart.id).toBe(`needs-you:${listNeedsMason({ runsDir }).find(i => i.text === restart.title)!.id}`);
    expect(inbox.sources['needs-you']).toEqual({ state: 'healthy', pending: 2 });
  });

  it('lists unanswered teammate texts, ranking decision requests above chatter', async () => {
    expect(recordTeammateText({ rowid: 41, handle: '+1555fake', text: 'thanks got it' }, runsDir, new Date(now - 5 * 60_000))).toBe(true);
    expect(recordTeammateText({ rowid: 42, handle: '+1555fake', text: 'Please approve the deploy?' }, runsDir, new Date(now - 60_000))).toBe(true);
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'imessage');
    expect(items).toHaveLength(2);
    const decision = items.find(i => i.id === 'imessage:teammate-42')!;
    expect(decision).toMatchObject({
      kind: 'teammate-text', severity: 'warn', blocking: false, title: 'Please approve the deploy?',
      act: ['phm fleet teammate-texts --answered 42', expect.stringContaining('bus-claim acquire --id imessage-teammate-42')],
    });
    expect(items.find(i => i.id === 'imessage:teammate-41')).toMatchObject({ severity: 'info', priority: 'this-week' });
    expect(inbox.items.indexOf(decision)).toBeLessThan(inbox.items.indexOf(items.find(i => i.id === 'imessage:teammate-41')!));
    markTeammateTextsAnswered([41, 42], runsDir, new Date(now));
    expect((await read()).items.filter(i => i.source === 'imessage')).toHaveLength(0);
  });

  it('lists pending drafts only, with show/approve/reject links and no body', async () => {
    const pending = await createDraft({ to: 'ops@example.com', subject: 'fake subject', body: 'fake body must not appear', source: 'outbox/fake.eml' }, runsDir);
    const decided = await createDraft({ to: 'other@example.com', subject: 'fake other', body: 'fake body', source: 'outbox/other.eml' }, runsDir);
    const { approveDraft } = await import('../src/core/cos/drafts.js');
    await approveDraft(decided.id, { runsDir });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'drafts');
    expect(items.map(i => i.id)).toEqual([`drafts:${pending.id}`]);
    expect(items[0]).toMatchObject({
      kind: 'draft-approval', severity: 'info', blocking: true, priority: 'now',
      title: 'Approve outbound email to ops@example.com',
      detail: 'fake subject · digest ' + pending.digest.slice(0, 12),
      act: [`phm drafts show ${pending.id}`, `phm drafts approve ${pending.id}`, `phm drafts reject ${pending.id}`],
    });
    expect(JSON.stringify(items)).not.toContain('must not appear');
  });

  it('lists live unclaimed work envelopes and hides claimed, completed, expired and non-work records', async () => {
    postWork('unclaimed', { priority: 'P1' });
    postWork('claimed'); claim('claimed');
    postWork('completed'); const done = claim('completed');
    expect(mutateBusWorkClaim({ action: 'complete', id: 'completed', token: done.token!, root: busRoot }).status).toBe('completed');
    postWork('expired', { ttl: 1, at: now - 10_000 });
    postWork('note', { kind: 'note' });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual(['bus:unclaimed']);
    expect(items[0]).toMatchObject({
      kind: 'bus-work', severity: 'warn', priority: 'today',
      title: 'fake work unclaimed',
      act: ['phm fleet bus-claim acquire --id unclaimed --owner <label> --lease-ms 600000'],
    });
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
    // The inspection view never leaks fencing tokens or lease internals.
    const table = inspectBusWorkClaims(busRoot);
    expect(table.source).toBe('available');
    expect(table.claims).toHaveLength(2);
    expect(table.claims.every(c => !('token' in c) && !('leaseMs' in c) && !('ttl' in c))).toBe(true);
  });

  it('lists exactly the bodies the claim contract accepts: protocol tasks in, disguised work out', async () => {
    // A protocol-v1 transport task is claimable by `bus next` but carries no
    // top-level kind, so the inbox must read the same isClaimableWork contract.
    postV2Body({ protocol: { version: 1, kind: 'task' }, correlation_id: 'corr-1', payload: { note: 'fake task payload' } });
    postV2Body({ protocol: { version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'deploy-ref-1' },
      correlation_id: 'corr-2', payload: {} }, { to: 'fleet.deploy', priority: 'P1' });
    // A kind:'work' body whose protocol is not a task is not claimable: the
    // protocol branch of isClaimableWork decides, so it stays off the list.
    postV2Body({ kind: 'work', text: 'fake disguised work', protocol: { version: 1, kind: 'status' } });
    // A kind:'work' body with a task protocol is claimable and titles from text.
    postV2Body({ kind: 'work', text: 'fake work with task protocol', protocol: { version: 1, kind: 'task' } });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual(['bus:v2-2', 'bus:v2-1', 'bus:v2-4']);
    expect(items[0]).toMatchObject({
      kind: 'bus-work', severity: 'warn',
      title: 'protocol task fleet.deploy: deploy-ref-1',
      detail: 'from agent:peer to fleet.deploy · P1 · cursor 2',
      act: [`phm fleet bus-claim acquire --id v2-2 --owner <label> --lease-ms 600000`],
    });
    expect(items[1]).toMatchObject({ title: 'protocol task' });
    expect(items[2]).toMatchObject({ title: 'fake work with task protocol' });
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 3 });
  });

  it('re-lists work whose claim lease has lapsed', async () => {
    postWork('stale'); claim('stale', 1_000);
    expect((await read()).items.filter(i => i.source === 'bus')).toHaveLength(0);
    now += 2_000;
    expect((await read()).items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:stale']);
  });

  it('hides work held by a live coordination claim on its queue key', async () => {
    postWork('coord-held'); postWork('coord-free');
    holdKey('queue:coord-held');
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:coord-free']);
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
  });

  it('re-lists work whose coordination lease has lapsed', async () => {
    postWork('coord-stale');
    const held = acquireCoordination({ root: busRoot, origin: 'resource', key: 'queue:coord-stale', owner: 'worker',
      leaseMs: 1_000, leaseUntil: now + 1_000, sourceId: 'test:coord-stale', now });
    expect(held.status).toBe('acquired');
    expect((await read()).items.filter(i => i.source === 'bus')).toHaveLength(0);
    now += 2_000;
    expect((await read()).items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:coord-stale']);
  });

  it('degrades the bus source when the coordination table is unreadable', async () => {
    postWork('coord-blind');
    mkdirSync(join(busRoot, 'coordination'), { recursive: true, mode: 0o700 });
    writeFileSync(join(busRoot, 'coordination', 'claims.json'), '{"version":1,"claims":{},"statuses":[]}', { mode: 0o600 });
    const inbox = await read();
    expect(inbox.sources.bus.state).toBe('degraded');
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:coord-blind']);
  });
});

describe('v2 work-feed jobs in the bus source', () => {
  it('lists open feed jobs with real titles, priorities and claim acts', async () => {
    postJob('RQ-OPEN', { title: 'fake open job', priority: 'P1', claimKeys: ['queue:RQ-OPEN', 'path:ashlrai/phantom:docs/**'] });
    postJob('RQ-DONE'); postStatus('RQ-DONE', 'done');
    postJob('RQ-RUN'); postStatus('RQ-RUN', 'running');
    postJob('RQ-RESCHED'); postStatus('RQ-RESCHED', 'rescheduled');
    postJob('RQ-EMPTY', { claimKeys: [] });
    postV2Body({ kind: 'work.post', jobId: 'RQ-OLD', title: 'fake old job', provider: 'codex-cmp',
      repo: 'ashlrai/phantom', claimKeys: ['queue:RQ-OLD'] }, { ttl: 1, at: now - 10_000 });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-OPEN', 'bus-feed:RQ-RESCHED']);
    const open = items.find(i => i.id === 'bus-feed:RQ-OPEN')!;
    expect(open).toMatchObject({
      kind: 'bus-work', severity: 'warn', blocking: false,
      title: 'fake open job',
      detail: 'owner agent:peer · codex-cmp · ashlrai/phantom · queued · 0/2 claim keys held',
      since: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 3_600_000).toISOString(),
      act: ['phm agents bus claim acquire --key queue:RQ-OPEN --owner <label> --lease-ms 600000',
        'phm agents bus work feed --claims'],
    });
    expect(items.find(i => i.id === 'bus-feed:RQ-RESCHED')!.detail).toContain('rescheduled');
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 2 });
  });

  it('carries the newest status detail into the feed item detail', async () => {
    postJob('RQ-WHY');
    postV2Body({ kind: 'work.status', jobId: 'RQ-WHY', status: 'rescheduled',
      detail: 'waiting on fake upstream' }, { from: 'agent:peer' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'bus-feed:RQ-WHY')!;
    expect(item.detail).toContain('rescheduled — waiting on fake upstream');
    // A newer status without detail clears it from the item too.
    postV2Body({ kind: 'work.status', jobId: 'RQ-WHY', status: 'queued' }, { from: 'agent:peer' });
    const cleared = await read();
    expect(cleared.items.find(i => i.id === 'bus-feed:RQ-WHY')!.detail)
      .not.toContain('waiting on fake upstream');
  });

  it('hides fully held jobs and reports partial holds honestly', async () => {
    postJob('RQ-HELD'); holdKey('queue:RQ-HELD');
    postJob('RQ-PART', { claimKeys: ['queue:RQ-PART', 'path:ashlrai/phantom:src/**'] });
    holdKey('queue:RQ-PART');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual(['bus-feed:RQ-PART']);
    expect(items[0]!.detail).toContain('1/2 claim keys held');
    expect(items[0]!.act[0]).toBe('phm agents bus claim acquire --key path:ashlrai/phantom:src/** --owner <label> --lease-ms 600000');
  });

  it('degrades the bus source on a refused feed while legacy items still list', async () => {
    postWork('legacy-ok', { priority: 'P1' });
    postJob('RQ-POISON'); postStatus('RQ-POISON', 'done', 'agent:other');
    const inbox = await read();
    expect(inbox.sources.bus.state).toBe('degraded');
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:legacy-ok']);
  });

  it('degrades rather than guessing when a post cannot resolve a provider', async () => {
    postV2Body({ kind: 'work.post', jobId: 'RQ-NOPROV', title: 'fake', repo: 'ashlrai/phantom', claimKeys: ['queue:RQ-NOPROV'] });
    const inbox = await read();
    expect(inbox.sources.bus).toEqual({ state: 'degraded', pending: 0 });
    expect(inbox.items.filter(i => i.id.startsWith('bus-feed:'))).toHaveLength(0);
  });

  it('lists feed candidates as degraded when the coordination table is unreadable', async () => {
    postJob('RQ-BLIND');
    mkdirSync(join(busRoot, 'coordination'), { recursive: true, mode: 0o700 });
    writeFileSync(join(busRoot, 'coordination', 'claims.json'), '{"version":1,"claims":{},"statuses":[]}', { mode: 0o600 });
    const inbox = await read();
    expect(inbox.sources.bus.state).toBe('degraded');
    const item = inbox.items.find(i => i.id === 'bus-feed:RQ-BLIND')!;
    expect(item.detail).toContain('claim holds unknown');
    expect(item.act[0]).toBe('phm agents bus claim acquire --key queue:RQ-BLIND --owner <label> --lease-ms 600000');
  });
});

describe('stuck work-feed jobs in the bus source', () => {
  it('lists blocked and failed jobs with the status report deep link, not a claim act', async () => {
    postJob('RQ-STUCK', { title: 'fake stuck job' });
    const blockedId = postV2Body({ kind: 'work.status', jobId: 'RQ-STUCK', status: 'blocked',
      detail: 'fake waiting on security review' });
    postJob('RQ-BROKEN', { title: 'fake broken job' });
    const failedId = postV2Body({ kind: 'work.status', jobId: 'RQ-BROKEN', status: 'failed' });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-BROKEN', 'bus-feed:RQ-STUCK']);
    const stuck = items.find(i => i.id === 'bus-feed:RQ-STUCK')!;
    expect(stuck).toMatchObject({
      kind: 'bus-work', severity: 'warn', blocking: false,
      title: 'fake stuck job',
      detail: 'owner agent:peer · codex-cmp · ashlrai/phantom · blocked — fake waiting on security review',
      since: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 3_600_000).toISOString(),
      act: [`phm agents bus show ${blockedId}`, 'phm agents bus work feed --job RQ-STUCK --claims'],
    });
    const broken = items.find(i => i.id === 'bus-feed:RQ-BROKEN')!;
    expect(broken).toMatchObject({
      severity: 'high', title: 'fake broken job',
      detail: 'owner agent:peer · codex-cmp · ashlrai/phantom · failed',
      act: [`phm agents bus show ${failedId}`, 'phm agents bus work feed --job RQ-BROKEN --claims'],
    });
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 2 });
  });

  it('hides jobs whose newest status is not stuck and still lists claimable work beside them', async () => {
    postJob('RQ-QUEUED');
    postJob('RQ-DONE2'); postStatus('RQ-DONE2', 'done');
    postJob('RQ-RUN2'); postStatus('RQ-RUN2', 'running');
    postJob('RQ-IDLE'); postStatus('RQ-IDLE', 'idle');
    postJob('RQ-TERM'); postStatus('RQ-TERM', 'terminated');
    postJob('RQ-REVIVED'); postV2Body({ kind: 'work.status', jobId: 'RQ-REVIVED', status: 'blocked' });
    postStatus('RQ-REVIVED', 'done');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual(['bus-feed:RQ-QUEUED']);
    expect(items[0]!.detail).toContain('queued');
    expect(items[0]!.act[0]).toContain('claim acquire');
  });

  it('lists a stuck job with no claim keys and cites the newest status report', async () => {
    postJob('RQ-NOKEYS', { claimKeys: [] });
    postV2Body({ kind: 'work.status', jobId: 'RQ-NOKEYS', status: 'blocked', detail: 'fake first reason' });
    const newestId = postV2Body({ kind: 'work.status', jobId: 'RQ-NOKEYS', status: 'blocked', detail: 'fake newest reason' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'bus-feed:RQ-NOKEYS')!;
    expect(item).toMatchObject({ severity: 'warn', title: 'fake job RQ-NOKEYS' });
    expect(item.detail).toContain('blocked — fake newest reason');
    expect(item.detail).not.toContain('first reason');
    expect(item.act).toEqual([`phm agents bus show ${newestId}`, 'phm agents bus work feed --job RQ-NOKEYS --claims']);
  });

  it('scrubs secret-shaped status detail before it reaches the item', async () => {
    postJob('RQ-SECRET');
    postV2Body({ kind: 'work.status', jobId: 'RQ-SECRET', status: 'failed',
      detail: 'token sk-abcdefghijklmnop leaked' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'bus-feed:RQ-SECRET')!;
    expect(item.detail).toContain('failed — token [REDACTED] leaked');
    expect(item.detail).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('worker-handoff assignments in the bus source', () => {
  const handoff = (taskId: string, prompt: string) => ({ kind: 'worker-handoff', taskId, prompt });

  it('lists a live handoff with receive and inspect acts until its TTL ends', async () => {
    const id = postV2Body(handoff('RQ-HANDOFF-1', 'fake handoff prompt'), { to: 'agent:worker-9', priority: 'P1' });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual([`bus-handoff:${id}`]);
    expect(items[0]).toMatchObject({
      kind: 'bus-handoff', severity: 'warn', blocking: false,
      title: 'handoff task RQ-HANDOFF-1: fake handoff prompt',
      detail: 'from agent:peer to agent:worker-9 · P1 · cursor 1',
      since: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 3_600_000).toISOString(),
      act: [
        `phm fleet handoff-receive --id ${id} --to agent:worker-9 --snapshot <abs-json> -- <program> [args...]`,
        `phm agents bus show ${id}`,
      ],
    });
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
  });

  it('lists channel-addressed handoffs with the literal group label', async () => {
    const id = postV2Body(handoff('RQ-HANDOFF-2', 'fake channel handoff'), { to: 'group:ops:general', priority: 'P0' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === `bus-handoff:${id}`)!;
    expect(item).toMatchObject({ kind: 'bus-handoff', severity: 'high' });
    expect(item.detail).toContain('to group:ops:general');
    expect(item.act[0]).toContain('--to group:ops:general');
  });

  it('hides expired and malformed handoff bodies', async () => {
    postV2Body(handoff('RQ-HANDOFF-3', 'fake expired'), { ttl: 1, at: now - 10_000 });
    // Extra keys, a non-fleet task id and an empty prompt all fail the shared
    // isWorkerHandoffBody contract the receive verbs enforce.
    postV2Body({ ...handoff('RQ-HANDOFF-4', 'fake extra key'), note: 'x' });
    postV2Body(handoff('bad id!', 'fake bad task'));
    postV2Body(handoff('RQ-HANDOFF-5', '   '));
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus')).toHaveLength(0);
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 0 });
  });

  it('lists handoffs next to unclaimed work without confusing the two kinds', async () => {
    postWork('still-work', { priority: 'P1' });
    const id = postV2Body(handoff('RQ-HANDOFF-6', 'fake alongside'), { to: 'agent:worker-9' });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual([`bus-handoff:${id}`, 'bus:still-work']);
    expect(items.find(i => i.id === `bus-handoff:${id}`)).toMatchObject({ kind: 'bus-handoff', severity: 'info' });
    expect(items.find(i => i.id === 'bus:still-work')).toMatchObject({ kind: 'bus-work' });
  });
});

describe('agent conversation threads in the unified inbox', () => {
  const ask = (text: string, thread: string, extra: { from?: string; to?: string; at?: number } = {}) =>
    postV2Body({ kind: 'note', text, thread }, { from: extra.from ?? 'agent:asker', to: extra.to ?? 'agent:reviewer', at: extra.at });

  it('lists waiting agent threads with inspect and reply deep links', async () => {
    const id = ask('can you review the diff?', 'review-7', { at: now - 3_600_000 });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'conversations');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'conversations:review-7', kind: 'agent-thread', severity: 'info', blocking: false,
      title: 'can you review the diff?',
      detail: 'from asker · waiting on reviewer · 1 message · waiting 1h 0m',
      since: new Date(now - 3_600_000).toISOString(),
      expiresAt: null,
      act: ['phm agents conversations', `phm agents bus show ${id}`,
        'phm agents bus post --to <sender-label> --text "<reply>" --thread review-7'],
    });
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 1 });
  });

  it('warns on handoff-kind waits that are not receivable worker-handoffs', async () => {
    ask('take this over?', 'esc-3');
    postV2Body({ kind: 'handoff', text: 'please take this', thread: 'esc-3' }, { from: 'agent:lead', to: 'agent:worker' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'conversations:esc-3')!;
    expect(item).toMatchObject({ kind: 'agent-thread', severity: 'warn', title: 'please take this' });
    expect(item.detail).toContain('waiting on worker');
  });

  it('clears the item once the thread is answered', async () => {
    ask('can you review the diff?', 'review-7');
    postV2Body({ kind: 'context', text: 'done — shipped', thread: 'review-7' }, { from: 'agent:reviewer', to: 'agent:asker' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'conversations')).toHaveLength(0);
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 0 });
  });

  it('keeps one item when the waiting message is already pending bus work', async () => {
    // A claimable work body ending in a question is both unclaimed work and an
    // unanswered ask; the bus item carries the claim act, so no thread repeats it.
    const id = postV2Body({ kind: 'work', text: 'fake work — can you take it?' }, { from: 'agent:lead', to: 'agent:worker' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual([`bus:${id}`]);
    expect(inbox.items.filter(i => i.source === 'conversations')).toHaveLength(0);
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 0 });
  });

  it('keeps one item when the waiting message is a live worker-handoff', async () => {
    const id = postV2Body({ kind: 'worker-handoff', taskId: 'RQ-H-9', prompt: 'fake handoff' }, { from: 'agent:lead', to: 'agent:worker-9' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual([`bus-handoff:${id}`]);
    expect(inbox.items.filter(i => i.source === 'conversations')).toHaveLength(0);
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 0 });
  });

  it('keeps one item when the feed already lists the job thread', async () => {
    postV2Body({ kind: 'work.post', jobId: 'RQ-FEED-1', title: 'fake feed job', provider: 'codex-cmp',
      repo: 'ashlrai/phantom', claimKeys: ['queue:RQ-FEED-1'] }, { from: 'agent:peer', to: 'agent:worker' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus-feed:RQ-FEED-1']);
    expect(inbox.items.filter(i => i.source === 'conversations')).toHaveLength(0);
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 0 });
  });

  it('lists a job announcement thread the feed does not cover', async () => {
    // No claim keys means no feed item and no claim act — the unanswered
    // announcement is exactly what this source exists to surface.
    postV2Body({ kind: 'work.post', jobId: 'RQ-SILENT', title: 'fake silent job', provider: 'codex-cmp',
      repo: 'ashlrai/phantom', claimKeys: [] }, { from: 'agent:peer', to: 'agent:worker' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'conversations:job:RQ-SILENT')!;
    expect(item).toMatchObject({ kind: 'agent-thread', severity: 'info', source: 'conversations' });
    expect(item.act).toContain('phm agents bus post --to <sender-label> --text "<reply>" --thread job:RQ-SILENT');
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 1 });
  });

  it('reports unavailable and degraded reads honestly and uses the seam', async () => {
    const convStub = (over: Partial<AgentConversations>): AgentConversations => ({
      schema: 'agents.conversations.v1', version: 1, generatedAt: new Date(now).toISOString(),
      source: 'available', conversations: [], waiting: 0, skipped: 0, ...over,
    });
    const seen: unknown[] = [];
    const degraded = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readConversations: (query) => { seen.push(query); return convStub({ skipped: 2 }); } });
    expect(seen).toEqual([{ waitingOnly: true }]);
    expect(degraded.sources.conversations).toEqual({ state: 'degraded', pending: 0 });
    const unavailable = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readConversations: () => convStub({ source: 'unavailable', conversations: null, waiting: null }) });
    expect(unavailable.sources.conversations).toEqual({ state: 'unavailable', pending: 0 });
    const throwing = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readConversations: () => { throw new Error('boom'); } });
    expect(throwing.sources.conversations).toEqual({ state: 'unavailable', pending: 0 });
  });
});

describe('owner-thread awaiting replies in the unified inbox', () => {
  const ownerSettings: OwnerThreadSettings = {
    ...emptyOwnerSettings(),
    owners: { desktop: 'local-owner' },
    confirmed: true,
    team: [{ channel: 'bus', id: 'local-owner' }],
  };
  const ownerOptions = (): OwnerThreadOptions => ({
    runsDir, busRoot, now: () => now, settings: ownerSettings, halted: false, paused: false,
    mailbox: { async accept() { return { status: 'accepted' as const }; } },
  });
  const acceptOwner = (text: string, key: string, at = now) => acceptOwnerInbound(
    { channel: 'desktop', senderId: 'local-owner', text, idempotencyKey: key, at }, ownerOptions());

  it('lists each awaiting inbound as a warn item with thread and reply deep links', async () => {
    await acceptOwner('first owner ping', 'desktop-msg-0001');
    await acceptOwner('second owner ping', 'desktop-msg-0002', now + 1_000);
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'owner-thread');
    expect(items.map(i => i.id).sort()).toEqual(['owner-thread:m1', 'owner-thread:m2']);
    expect(items.find(i => i.id === 'owner-thread:m1')).toMatchObject({
      kind: 'owner-message', severity: 'warn', blocking: false,
      title: 'first owner ping',
      detail: 'via desktop · awaiting recorded reply',
      since: new Date(now).toISOString(),
      expiresAt: null,
      act: ['phm comms thread', 'phm comms send-owner --text "<reply>" --reply-to desktop-msg-0001'],
    });
    expect(inbox.sources['owner-thread']).toEqual({ state: 'healthy', pending: 2 });
  });

  it('clears an item once a recorded reply cites the inbound', async () => {
    await acceptOwner('ping the leader', 'desktop-msg-0001');
    expect((await read()).items.filter(i => i.source === 'owner-thread')).toHaveLength(1);
    // No transports attached: the reply records as refused yet still answers
    // the inbound — the same mark `phm comms status` reports.
    const reply = await sendOwnerReply({ text: 'leader answer', replyTo: 'desktop-msg-0001', idempotencyKey: 'reply-owner-01' }, ownerOptions());
    expect(reply.status).toBe('refused');
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'owner-thread')).toHaveLength(0);
    expect(inbox.sources['owner-thread']).toEqual({ state: 'healthy', pending: 0 });
  });

  it('does not clear the item for a proactive notice', async () => {
    await acceptOwner('still waiting', 'desktop-msg-0001');
    await postOwnerNotice({ text: 'leader line', idempotencyKey: 'notice-owner-01' }, ownerOptions());
    expect((await read()).items.filter(i => i.source === 'owner-thread')).toHaveLength(1);
  });

  it('reports an unreadable thread as unavailable and still lists the other sources', async () => {
    mkdirSync(join(runsDir, 'leader'), { recursive: true });
    writeFileSync(join(runsDir, 'leader', 'owner-thread.json'), 'not json', { mode: 0o600 });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await read();
    expect(inbox.sources['owner-thread']).toEqual({ state: 'unavailable', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'owner-thread')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('degrades on a throwing seam and builds items from a stubbed read', async () => {
    const throwing = await readUnifiedInbox({ runsDir, busRoot, now: () => now, readOwnerAwaiting: () => { throw new Error('boom'); } });
    expect(throwing.sources['owner-thread']).toEqual({ state: 'unavailable', pending: 0 });
    const stubbed = await readUnifiedInbox({
      runsDir, busRoot, now: () => now,
      readOwnerAwaiting: () => ({ status: 'ok', items: [{
        id: 'm9', idempotencyKey: 'stub-key-0001', channel: 'telegram' as const,
        at: new Date(now - 60_000).toISOString(), text: 'stubbed owner text',
      }] }),
    });
    const item = stubbed.items.find(i => i.source === 'owner-thread')!;
    expect(item).toMatchObject({
      id: 'owner-thread:m9', kind: 'owner-message', severity: 'warn',
      title: 'stubbed owner text', detail: 'via telegram · awaiting recorded reply',
      act: ['phm comms thread', 'phm comms send-owner --text "<reply>" --reply-to stub-key-0001'],
    });
    expect(stubbed.sources['owner-thread']).toEqual({ state: 'healthy', pending: 1 });
  });
});

describe('readUnifiedInbox ordering and bounds', () => {
  it('orders severity band first, then priority, then expiry', async () => {
    // info band: a teammate text (this-week) and a P2 work item expiring in 2 days.
    recordTeammateText({ rowid: 50, handle: '+1555fake', text: 'status?' }, runsDir, new Date(now - 60_000));
    postWork('slow-p2', { priority: 'P2', ttl: 48 * 3_600_000 });
    // warn band: needs-you (blocking → now) and P1 work (warn → today).
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    postWork('patient-p1', { priority: 'P1', ttl: 72 * 3_600_000 });
    // high band: P0 work expiring in an hour (now) — tops the list.
    postWork('hot-p0', { priority: 'P0', ttl: 3_600_000 });
    const inbox = await read();
    expect(inbox.total).toBe(5);
    const ids = inbox.items.map(i => i.id);
    expect(ids[0]).toBe('bus:hot-p0');                                   // high band
    expect(ids[1]).toMatch(/^needs-you:nm-[0-9a-f]{12}$/);               // warn band, now
    expect(ids[2]).toBe('bus:patient-p1');                               // warn band, today
    expect(ids[3]).toBe('bus:slow-p2');                                  // info band, finite expiry first
    expect(ids[4]).toBe('imessage:teammate-50');                         // info band, no expiry
    expect(inbox.items.map(i => i.priority)).toEqual(['now', 'now', 'today', 'this-week', 'this-week']);
  });

  it('caps the items array and reports the omitted remainder', async () => {
    postWorkSnapshot(Array.from({ length: UNIFIED_INBOX_MAX_ITEMS + 5 }, (_, i) => `bulk-${String(i).padStart(4, '0')}`));
    const inbox = await read();
    expect(inbox.items).toHaveLength(UNIFIED_INBOX_MAX_ITEMS);
    expect(inbox.total).toBe(UNIFIED_INBOX_MAX_ITEMS + 5);
    expect(inbox.omitted).toBe(5);
  });
});

describe('phm comms inbox cli', () => {
  const setupCli = () => {
    const command = createCommsInboxCommand({ runsDir, busRoot });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = () => log.mock.calls.map(c => String(c[0]));
    const json = () => JSON.parse(lines().at(-1)!) as UnifiedInbox;
    return { command, lines, json };
  };

  it('prints the unified JSON report for `inbox --json`', async () => {
    const { command, json } = setupCli();
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    postWork('cli-work', { priority: 'P1' });
    expect(await command(['--json'])).toBe(0);
    const report = json();
    expect(report.v).toBe(1);
    expect(report.total).toBe(2);
    expect(report.items.map(i => i.source).sort()).toEqual(['bus', 'needs-you']);
    expect(report.items.every(i => i.act.length > 0)).toBe(true);
  });

  it('prints a prioritized human view for bare `inbox`', async () => {
    const { command, lines } = setupCli();
    expect(await command([])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending.');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- restart the worker pool\n');
    expect(await command([])).toBe(0);
    const out = lines().join('\n');
    expect(out).toContain('[now] needs-you  restart the worker pool');
    expect(out).toContain('phm fleet needs-resolve');
    expect(out).toContain('1 pending');
  });

  it('keeps read/post and help while refusing malformed unified invocations', async () => {
    const { command, lines } = setupCli();
    expect(await command(['--help'])).toBe(0);
    expect(lines().at(-1)).toContain('phm comms inbox [--json]');
    for (const args of [['--json', '--json'], ['unified'], ['--limit', '5'], ['bogus', '--json']]) {
      expect(await command(args)).toBe(2);
      expect(JSON.parse(lines().at(-1)!)).toEqual({ status: 'invalid' });
    }
    expect(await command(['read', '--json'])).toBe(0);
    expect(JSON.parse(lines().at(-1)!)).toEqual({ sourceState: 'missing', entries: [] });
  });
});
