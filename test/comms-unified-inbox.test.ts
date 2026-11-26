/**
 * Unified comms inbox (`phm comms inbox [--json]`): aggregates unresolved
 * needs-you lines, unanswered teammate texts, owner-thread messages awaiting
 * a recorded reply, pending drafts and unclaimed bus work into one prioritized
 * list with deep links. Hermetic: every store lives under a temp dir; no
 * network, no model calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDraft } from '../src/core/cos/drafts.js';
import { appendDraft as appendCommsDraft, type CommsDraft } from '../src/core/comms-agent/store.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { emptyOwnerSettings, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, postOwnerNotice, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { readUnifiedInbox, UNIFIED_INBOX_MAX_ITEMS, type UnifiedInbox, type UnifiedInboxOptions } from '../src/core/comms/unified-inbox.js';
import type { ProposalApprovalItem, Section, TeamApprovalItem } from '../src/core/approvals/surface.js';
import type { SeatHandoff, SeatHandoffPlanEntry, SeatHandoffsPlan } from '../src/core/bots/seats.js';
import type { CommsRequest, CommsRequestsRead } from '../src/core/comms/requests.js';
import { DEFAULT_TEAM } from '../src/core/teams/tools.js';
import { markTeammateTextsAnswered, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { writeEmailDropConfig, type EmailDropConfig } from '../src/core/comms/email-drop-config.js';
import { EMAIL_OUTBOX_MAX_BYTES } from '../src/core/comms/email-outbox.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { createAgentChannel, registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { createBusMailbox, type BusMailboxPendingMessage } from '../src/core/fleet/bus-mailbox.js';
import { BusBoard, type BusBoardPendingPeers, type BusBoardPendingTask, type BusBoardTaskHold } from '../src/core/fleet/bus-board.js';
import type { BusBoardDelivery } from '../src/core/fleet/bus-delivery.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { AgentConversations } from '../src/core/fleet/agent-conversations.js';
import type { SlackJournalRead, SlackObservation } from '../src/core/agents/slack-journal.js';
import type { BusEnvelope, BusJsonValue } from '../src/core/fleet/bus-envelope.js';
import type { AgentWakeRow, AllWakesPage } from '../src/core/agents/bus-unified.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { writeDelivery } from '../src/core/fleet/needs-mason-reply-delivery.js';
import { resolveNeedsMasonWithInbox } from '../src/core/fleet/needs-mason-relay.js';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';

let root: string, runsDir: string, busRoot: string, now: number;
const roots: string[] = [];
// Mirrors the opaque id scheme in unified-inbox.ts (sha256 of the artifact name, 16 hex).
const outboxId = (name: string): string => `email-outbox:${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unified-inbox-')); roots.push(root);
  runsDir = join(root, 'runs'); mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  busRoot = join(root, 'bus'); mkdirSync(busRoot, { recursive: true, mode: 0o700 });
  now = Date.parse('2026-11-07T12:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

// The requests store lives at ~/.ashlr/comms, outside this file's temp dirs;
// pin it to a verified-empty read so the suite stays hermetic. The requests
// source has its own describe block below with an injected reader.
const read = (extra: Partial<UnifiedInboxOptions> = {}): Promise<UnifiedInbox> => readUnifiedInbox({
  runsDir, busRoot, now: () => now,
  readRequests: () => ({ status: 'missing', requests: [] }),
  ...extra,
});

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
function postJob(jobId: string, over: { title?: string; claimKeys?: string[]; provider?: string; priority?: 'P0' | 'P1' | 'P2' | 'P3'; ttl?: number; at?: number; from?: string; to?: string } = {}) {
  return postV2Body({ kind: 'work.post', jobId, title: over.title ?? `fake job ${jobId}`,
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
        'teammate-tasks': { state: 'missing', pending: 0 },
        drafts: { state: 'healthy', pending: 0 },
        bus: { state: 'missing', pending: 0 },
        mailbox: { state: 'missing', pending: 0 },
        board: { state: 'missing', pending: 0 },
        conversations: { state: 'missing', pending: 0 },
        wakes: { state: 'healthy', pending: 0 },
        seats: { state: 'missing', pending: 0 },
        'peer-dispatch': { state: 'missing', pending: 0 },
        'email-inbox': { state: 'missing', pending: 0 },
        'email-outbox': { state: 'missing', pending: 0 },
        'team-approvals': { state: 'healthy', pending: 0 },
        proposals: { state: 'healthy', pending: 0 },
      },
    });
  });

  it('lists unresolved needs-you lines with the needs-you class verdict', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- restart the worker pool on mac-2\n- Rotate the deploy secret for the example app\n');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'needs-you');
    expect(items).toHaveLength(2);
    const restart = items.find(i => i.title === 'restart the worker pool on mac-2')!;
    // An auto line is ordinary work the fleet resolves: warn, non-blocking,
    // `resolve --auto` first, and the class named in the detail.
    expect(restart).toMatchObject({
      kind: 'needs-you', severity: 'warn', blocking: false, priority: 'today',
      detail: 'auto — ordinary engineering work; the fleet goes ahead',
      act: ['phm needs-you resolve --auto', expect.stringMatching(/^phm fleet needs-resolve nm-[0-9a-f]{12} --reply "<reply>"$/)],
    });
    expect(restart.id).toBe(`needs-you:${listNeedsMason({ runsDir }).find(i => i.text === restart.title)!.id}`);
    const secret = items.find(i => i.title === 'Rotate the deploy secret for the example app')!;
    // A hard-limit line still waits on Mason: blocking, with the limit named.
    expect(secret).toMatchObject({
      kind: 'needs-you', severity: 'warn', blocking: true, priority: 'now',
      detail: 'hard limit — secrets or keys',
      act: [expect.stringMatching(/^phm fleet needs-resolve nm-[0-9a-f]{12} --reply "<reply>"$/)],
    });
    expect(inbox.sources['needs-you']).toEqual({ state: 'healthy', pending: 2 });
    // --blocking keeps only the hard-limit item; the auto line stays listed unfiltered.
    const blocking = await read({ filter: { blocking: true } });
    expect(blocking.items.filter(i => i.source === 'needs-you').map(i => i.id)).toEqual([secret.id]);
    expect(blocking.sources['needs-you']).toEqual({ state: 'healthy', pending: 2 });
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

  it('lists pending comms-agent reply drafts once, deduped against cos mirrors and sent records', async () => {
    const commsDraft = (id: string, over: Partial<CommsDraft> = {}): CommsDraft => ({
      id, status: 'pending', transport: 'imessage', recipient: '+1555fake',
      subject: 'imessage reply', body: 'fake reply body', messageId: 'msg-1',
      createdAt: new Date(now - 60_000).toISOString(), ...over,
    });
    await appendCommsDraft(runsDir, commsDraft('c-aaa'));
    await appendCommsDraft(runsDir, commsDraft('c-bbb', { transport: 'email', recipient: 'ops@example.com', subject: 'email reply' }));
    await appendCommsDraft(runsDir, commsDraft('c-ccc', { status: 'sent', resolvedAt: new Date(now).toISOString() }));
    // The cos mirror of c-bbb — even once decided — still suppresses the
    // comms-agent record so one pending reply is one item.
    const mirror = await createDraft({ to: 'ops@example.com', subject: 'email reply', body: 'fake reply body', source: 'comms-agent:c-bbb' }, runsDir);
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'drafts');
    expect(items.map(i => i.id).sort()).toEqual([`drafts:${mirror.id}`, 'drafts:c-aaa'].sort());
    const comms = items.find(i => i.id === 'drafts:c-aaa')!;
    expect(comms).toMatchObject({
      kind: 'draft-approval', severity: 'info', blocking: true, priority: 'now',
      title: 'Comms reply draft via imessage',
      detail: 'imessage reply',
      act: ['phm comms-agent drafts'],
    });
    // The recipient can be a handle: it never reaches the item.
    expect(JSON.stringify(items)).not.toContain('+1555fake');
    expect(inbox.sources.drafts).toEqual({ state: 'healthy', pending: 2 });
  });

  it('reports the drafts source degraded when the comms-agent draft store cannot be read', async () => {
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      listCommsDrafts: async () => { throw new Error('unreadable'); },
    });
    expect(inbox.sources.drafts.state).toBe('degraded');
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
    // A live hold keeps the running job in progress, not stalled.
    postJob('RQ-RUN'); postStatus('RQ-RUN', 'running'); holdKey('queue:RQ-RUN');
    postJob('RQ-RESCHED'); postStatus('RQ-RESCHED', 'rescheduled');
    const emptyPost = postJob('RQ-EMPTY', { claimKeys: [] });
    postV2Body({ kind: 'work.post', jobId: 'RQ-OLD', title: 'fake old job', provider: 'codex-cmp',
      repo: 'ashlrai/phantom', claimKeys: ['queue:RQ-OLD'] }, { ttl: 1, at: now - 10_000 });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-EMPTY', 'bus-feed:RQ-OPEN', 'bus-feed:RQ-RESCHED']);
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
    // A queued job with no claim keys lists too: `work claim` refuses it
    // `no-claim-keys`, so it is unclaimable work needing a decision — the
    // announcement's own post handle, never a claim act.
    const empty = items.find(i => i.id === 'bus-feed:RQ-EMPTY')!;
    expect(empty).toMatchObject({
      kind: 'bus-work', severity: 'warn', blocking: false,
      title: 'fake job RQ-EMPTY',
      detail: 'owner agent:peer · codex-cmp · ashlrai/phantom · queued · declares no claim keys; nothing can claim it',
      act: [`phm agents bus show ${emptyPost}`, 'phm agents bus work feed --job RQ-EMPTY --claims'],
    });
    expect(empty.act.join(' ')).not.toContain('claim acquire');
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 3 });
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

  it('lists a refused feed as pending work naming the blamed receipt', async () => {
    postJob('RQ-POISON');
    const poisonId = postV2Body({ kind: 'work.status', jobId: 'RQ-POISON', status: 'done' }, { from: 'agent:other' });
    const inbox = await read();
    expect(inbox.sources.bus).toEqual({ state: 'degraded', pending: 1 });
    const item = inbox.items.find(i => i.id === 'bus-feed-refused')!;
    expect(item).toMatchObject({
      source: 'bus', kind: 'bus-work', severity: 'high', blocking: false,
      title: 'work feed refused: owner-mismatch',
      detail: `every announced job is hidden and work verbs refuse until the receipt expires · receipt ${poisonId}`,
      since: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 3_600_000).toISOString(),
      act: [`phm agents bus show ${poisonId}`, 'phm agents bus work feed'],
    });
    // The refused feed still hides every job — no feed items list beside it.
    expect(inbox.items.filter(i => i.id.startsWith('bus-feed:'))).toHaveLength(0);
  });

  it('lists a receipt-less refusal with unknown times and no show link', async () => {
    postWork('legacy-ok', { priority: 'P1' });
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      readFeed: () => ({ status: 'refused', reason: 'invalid-receipts', receipts: 2,
        asOf: new Date(now).toISOString() }),
    });
    expect(inbox.sources.bus.state).toBe('degraded');
    const item = inbox.items.find(i => i.id === 'bus-feed-refused')!;
    expect(item).toMatchObject({
      kind: 'bus-work', severity: 'high',
      title: 'work feed refused: invalid-receipts',
      since: null, expiresAt: null,
      act: ['phm agents bus work feed'],
    });
    expect(item.detail).toBe('every announced job is hidden and work verbs refuse until the receipt expires');
    // Legacy claimable work still lists beside the refusal item.
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id).sort())
      .toEqual(['bus-feed-refused', 'bus:legacy-ok']);
  });

  it('degrades the bus source on a refused feed while legacy items still list', async () => {
    postWork('legacy-ok', { priority: 'P1' });
    postJob('RQ-POISON'); postStatus('RQ-POISON', 'done', 'agent:other');
    const inbox = await read();
    expect(inbox.sources.bus.state).toBe('degraded');
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id))
      .toEqual(['bus-feed-refused', 'bus:legacy-ok']);
  });

  it('degrades rather than guessing when a post cannot resolve a provider', async () => {
    postV2Body({ kind: 'work.post', jobId: 'RQ-NOPROV', title: 'fake', repo: 'ashlrai/phantom', claimKeys: ['queue:RQ-NOPROV'] });
    const inbox = await read();
    expect(inbox.sources.bus).toEqual({ state: 'degraded', pending: 1 });
    const item = inbox.items.find(i => i.id === 'bus-feed-refused')!;
    expect(item.title).toBe('work feed refused: missing-provider');
    expect(item.act[0]).toMatch(/^phm agents bus show v2-\d+$/);
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
    // Live holds keep the in-progress jobs off the stalled list too.
    postJob('RQ-RUN2'); postStatus('RQ-RUN2', 'running'); holdKey('queue:RQ-RUN2');
    postJob('RQ-IDLE'); postStatus('RQ-IDLE', 'idle'); holdKey('queue:RQ-IDLE');
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

describe('unclaimable work-feed jobs in the bus source', () => {
  it('lists a rescheduled zero-key job with its status detail and no claim act', async () => {
    const post = postJob('RQ-NOCLAIM', { claimKeys: [] });
    postV2Body({ kind: 'work.status', jobId: 'RQ-NOCLAIM', status: 'rescheduled',
      detail: 'fake waiting on review' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'bus-feed:RQ-NOCLAIM')!;
    expect(item).toMatchObject({
      kind: 'bus-work', severity: 'warn', blocking: false,
      title: 'fake job RQ-NOCLAIM',
      detail: 'owner agent:peer · codex-cmp · ashlrai/phantom · rescheduled — fake waiting on review · declares no claim keys; nothing can claim it',
      act: [`phm agents bus show ${post}`, 'phm agents bus work feed --job RQ-NOCLAIM --claims'],
    });
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
  });

  it('ranks a P0 unclaimable announcement high and keeps claimable work beside it', async () => {
    postJob('RQ-P0EMPTY', { claimKeys: [], priority: 'P0' });
    postJob('RQ-FINE');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-FINE', 'bus-feed:RQ-P0EMPTY']);
    expect(items.find(i => i.id === 'bus-feed:RQ-P0EMPTY')!.severity).toBe('high');
    expect(items.find(i => i.id === 'bus-feed:RQ-FINE')!.act[0]).toContain('claim acquire');
  });

  it('still hides open jobs in non-open statuses even with no claim keys', async () => {
    postJob('RQ-RUNEMPTY', { claimKeys: [] });
    postStatus('RQ-RUNEMPTY', 'running');
    postJob('RQ-IDLEMPTY', { claimKeys: [] });
    postStatus('RQ-IDLEMPTY', 'idle');
    const inbox = await read();
    expect(inbox.items.filter(i => i.id.startsWith('bus-feed:'))).toHaveLength(0);
  });
});

describe('stalled work-feed jobs in the bus source', () => {
  it('lists a running job whose declared keys provably lost every live hold', async () => {
    postJob('RQ-STALL', { title: 'fake stalled job' });
    const statusId = postV2Body({ kind: 'work.status', jobId: 'RQ-STALL', status: 'running',
      detail: 'fake worker went quiet' });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual(['bus-feed:RQ-STALL']);
    expect(items[0]).toMatchObject({
      kind: 'bus-work', severity: 'warn', blocking: false,
      title: 'fake stalled job',
      detail: 'owner agent:peer · codex-cmp · ashlrai/phantom · running — fake worker went quiet · no live claim on its declared keys; only the announcer can move it',
      since: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 3_600_000).toISOString(),
      act: [`phm agents bus show ${statusId}`, 'phm agents bus work feed --job RQ-STALL --claims'],
    });
    // A stalled job is not claimable work: no claim act is offered.
    expect(items[0]!.act.join(' ')).not.toContain('claim acquire');
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
  });

  it('ranks a P0 stalled announcement high and keeps an idle one warn beside claimable work', async () => {
    postJob('RQ-IDLEP0', { priority: 'P0' });
    postStatus('RQ-IDLEP0', 'idle');
    postJob('RQ-RUNP2');
    postStatus('RQ-RUNP2', 'running');
    postJob('RQ-OPEN2');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-IDLEP0', 'bus-feed:RQ-OPEN2', 'bus-feed:RQ-RUNP2']);
    expect(items.find(i => i.id === 'bus-feed:RQ-IDLEP0')!.severity).toBe('high');
    expect(items.find(i => i.id === 'bus-feed:RQ-RUNP2')!.severity).toBe('warn');
    expect(items.find(i => i.id === 'bus-feed:RQ-RUNP2')!.detail).toContain('running');
    expect(items.find(i => i.id === 'bus-feed:RQ-OPEN2')!.act[0]).toContain('claim acquire');
  });

  it('hides in-progress jobs while any declared key keeps a live hold', async () => {
    postJob('RQ-HELDSTUDY'); postStatus('RQ-HELDSTUDY', 'running'); holdKey('queue:RQ-HELDSTUDY');
    postJob('RQ-PARTSTUDY', { claimKeys: ['queue:RQ-PARTSTUDY', 'path:ashlrai/phantom:src/**'] });
    postStatus('RQ-PARTSTUDY', 'idle'); holdKey('queue:RQ-PARTSTUDY');
    const inbox = await read();
    expect(inbox.items.filter(i => i.id.startsWith('bus-feed:'))).toHaveLength(0);
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 0 });
  });

  it('lists a job as stalled only once its last hold lapses', async () => {
    postJob('RQ-LAPSE'); postStatus('RQ-LAPSE', 'running');
    holdKey('queue:RQ-LAPSE');
    expect((await read()).items.filter(i => i.id.startsWith('bus-feed:'))).toHaveLength(0);
    now += 700_000;
    const items = (await read()).items.filter(i => i.id.startsWith('bus-feed:'));
    expect(items.map(i => i.id)).toEqual(['bus-feed:RQ-LAPSE']);
    expect(items[0]!.detail).toContain('no live claim on its declared keys');
  });

  it('keeps unproven stalls hidden when the coordination table is unreadable', async () => {
    postJob('RQ-BLINDSTALL'); postStatus('RQ-BLINDSTALL', 'running');
    mkdirSync(join(busRoot, 'coordination'), { recursive: true, mode: 0o700 });
    writeFileSync(join(busRoot, 'coordination', 'claims.json'), '{"version":1,"claims":{},"statuses":[]}', { mode: 0o600 });
    const inbox = await read();
    expect(inbox.items.filter(i => i.id.startsWith('bus-feed:'))).toHaveLength(0);
    expect(inbox.sources.bus.state).toBe('degraded');
  });

  it('keeps queued candidates visible when hold coverage is absent or truncated', async () => {
    postJob('RQ-CANDIDATE');
    for (const claims of [undefined, { source: 'available' as const, truncated: true, holds: [{
      jobId: 'RQ-CANDIDATE', claimKey: 'queue:RQ-CANDIDATE', owner: 'fake-holder',
      leaseUntil: now + 60_000, origin: 'resource' as const, sourceId: 'fake-hold',
    }] }]) {
      const inbox = await read({ readFeed: () => ({
        status: 'ok', receipts: 1, asOf: new Date(now).toISOString(), claims,
        jobs: [{ id: 'RQ-CANDIDATE', title: 'fake candidate', owner: 'agent:peer', to: 'leaders',
          provider: 'codex-cmp', repo: 'ashlrai/phantom', status: 'queued', updatedAt: now,
          claimKeys: ['queue:RQ-CANDIDATE'], postId: 'v2-1', statusId: null }],
      }) });
      expect(inbox.sources.bus).toEqual({ state: 'degraded', pending: 1 });
      expect(inbox.items.find(i => i.id === 'bus-feed:RQ-CANDIDATE')?.detail).toContain('claim holds unknown');
    }
  });

  it('keeps stalls hidden under truncated hold coverage', async () => {
    // The bus store must be readable for the feed section to run at all.
    postJob('RQ-TRUNC'); postStatus('RQ-TRUNC', 'running');
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      readFeed: () => ({
        status: 'ok', receipts: 2, asOf: new Date(now).toISOString(),
        jobs: [{
          id: 'RQ-TRUNC', owner: 'agent:peer', to: 'leaders', provider: 'codex-cmp',
          repo: 'ashlrai/phantom', title: 'fake stalled job', claimKeys: ['queue:RQ-TRUNC'],
          status: 'running', updatedAt: now, postId: 'v2-1', statusId: 'v2-2',
        }],
        claims: { source: 'available', holds: [], truncated: true },
      }),
    });
    expect(inbox.items.filter(i => i.id.startsWith('bus-feed:'))).toHaveLength(0);
    expect(inbox.sources.bus).toEqual({ state: 'degraded', pending: 0 });
  });

  it('distinguishes a reported work.result from abandoned stalled work', async () => {
    const workResult = (jobId: string, outcome: string, reason?: string) =>
      postV2Body({ kind: 'work.result', jobId, claimKey: `queue:${jobId}`,
        queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        outcome, ...(reason === undefined ? {} : { reason }) }, { from: 'agent:worker-9' });
    // A terminal report means the worker answered: the item cites the result
    // receipt and says the report was made, instead of reading as abandoned.
    postJob('RQ-DONE-REPORTED');
    const doneStatus = postV2Body({ kind: 'work.status', jobId: 'RQ-DONE-REPORTED', status: 'running' });
    const doneResult = workResult('RQ-DONE-REPORTED', 'complete', 'paths-not-allowed');
    // An in-flight report means the dispatch pipeline still owns the outcome:
    // the job hides like a held one would.
    postJob('RQ-INFLIGHT'); postStatus('RQ-INFLIGHT', 'running');
    workResult('RQ-INFLIGHT', 'admitted');
    // A failed report relabels the same way complete does.
    postJob('RQ-FAILED-REPORTED'); postStatus('RQ-FAILED-REPORTED', 'idle');
    workResult('RQ-FAILED-REPORTED', 'failed', 'repo-not-allowed');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-DONE-REPORTED', 'bus-feed:RQ-FAILED-REPORTED']);
    const done = items.find(i => i.id === 'bus-feed:RQ-DONE-REPORTED')!;
    expect(done.detail).toContain('work.result complete reported by agent:worker-9 (paths-not-allowed)');
    expect(done.detail).toContain('only the announcer can move it');
    expect(done.act).toEqual([`phm agents bus show ${doneResult}`, `phm agents bus show ${doneStatus}`,
      'phm agents bus work feed --job RQ-DONE-REPORTED --claims']);
    const failed = items.find(i => i.id === 'bus-feed:RQ-FAILED-REPORTED')!;
    expect(failed.detail).toContain('work.result failed reported by agent:worker-9 (repo-not-allowed)');
  });

  it('annotates claimable feed jobs with any reported work.result outcome', async () => {
    postJob('RQ-REPORTED-OPEN');
    postV2Body({ kind: 'work.result', jobId: 'RQ-REPORTED-OPEN', claimKey: 'queue:RQ-REPORTED-OPEN',
      queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome: 'admitted' },
      { from: 'agent:worker-9' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'bus-feed:RQ-REPORTED-OPEN')!;
    // An open job still lists as claimable — the report is evidence a claimant
    // sees, never a reason to hide provably free work.
    expect(item.detail).toContain('result admitted reported by agent:worker-9');
    expect(item.act[0]).toContain('claim acquire');
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

  it('drops a handoff the addressee already answered with a routed reply', async () => {
    const id = postV2Body(handoff('RQ-HANDOFF-7', 'fake answered handoff'), { to: 'agent:worker-9', priority: 'P1' });
    // Pending until the assignee's routed answer cites it.
    expect((await read()).items.map(i => i.id)).toContain(`bus-handoff:${id}`);
    // The worker-exit reply the handoff verbs publish routes recipient ->
    // sender and cites the handoff id — the same evidence conversations credit.
    postV2Body({ kind: 'worker-exit', inReplyTo: id, exitCode: 0, succeeded: true },
      { from: 'agent:worker-9', to: 'agent:peer' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus')).toHaveLength(0);
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 0 });
  });

  it('keeps a handoff pending when the citation is not the assignee answering back', async () => {
    const id = postV2Body(handoff('RQ-HANDOFF-8', 'fake unanswered handoff'), { to: 'agent:worker-9' });
    // The assigner replying to the assignee is the handoff's own direction,
    // not the assignee's answer; a bystander's citation is no answer at all.
    postV2Body({ kind: 'worker-exit', inReplyTo: id, exitCode: 0, succeeded: true },
      { from: 'agent:peer', to: 'agent:worker-9' });
    postV2Body({ kind: 'note', inReplyTo: id, text: 'fyi' }, { from: 'agent:bystander', to: 'leaders' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual([`bus-handoff:${id}`]);
  });

  it('drops a handoff answered under another label of the same identities', async () => {
    registerAgentIdentity({ handle: 'worker-9', aliases: ['w9-lane'] }, { root: busRoot });
    registerAgentIdentity({ handle: 'peer', aliases: ['peer-alias'] }, { root: busRoot });
    const id = postV2Body(handoff('RQ-HANDOFF-9', 'fake alias-answered handoff'), { to: 'agent:worker-9' });
    expect((await read()).items.map(i => i.id)).toContain(`bus-handoff:${id}`);
    // The assignee's lane alias answers the assigner's alias — the same two
    // identities under different routing labels, still recipient -> sender.
    postV2Body({ kind: 'note', inReplyTo: id, text: 'done on the lane' },
      { from: 'w9-lane', to: 'peer-alias' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus')).toHaveLength(0);
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 0 });
  });

  it('drops a channel-addressed handoff a channel member answered', async () => {
    registerAgentIdentity({ handle: 'worker-9' }, { root: busRoot });
    registerAgentIdentity({ handle: 'peer' }, { root: busRoot });
    registerAgentIdentity({ handle: 'member-1' }, { root: busRoot });
    registerAgentIdentity({ handle: 'outsider' }, { root: busRoot });
    expect(createAgentChannel({ name: 'ops', createdBy: 'peer', members: ['worker-9', 'member-1'] },
      { root: busRoot }).status).toBe('created');
    const id = postV2Body(handoff('RQ-HANDOFF-10', 'fake room handoff'), { to: 'group:ops:general' });
    // member-1 — a room member, not the assigner — answers under its own
    // label routed to the assigner: the room is the assignee set.
    postV2Body({ kind: 'note', inReplyTo: id, text: 'room took it' },
      { from: 'agent:member-1', to: 'agent:peer' });
    const answered = await read();
    expect(answered.items.filter(i => i.source === 'bus')).toHaveLength(0);
    // A registered non-member's citation is no answer: the next room handoff
    // stays pending.
    const second = postV2Body(handoff('RQ-HANDOFF-11', 'fake room handoff two'), { to: 'group:ops:general' });
    postV2Body({ kind: 'note', inReplyTo: second, text: 'not mine to answer' },
      { from: 'agent:outsider', to: 'agent:peer' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual([`bus-handoff:${second}`]);
  });
});

describe('dead-letter reports in the bus source', () => {
  /** The sink's wire body (bus-transport-file `createFileDeadLetterSink`): a
   * protocol status whose payload carries the deadLetter summary, the
   * payloadDropped flag and the kept original transport envelope or null. */
  const deadLetterBody = (over: { reason?: string; priority?: string; attempts?: number; payloadDropped?: boolean; withPayload?: boolean } = {}) => ({
    protocol: { version: 1, kind: 'status' },
    correlation_id: 'corr-dead-1',
    payload: {
      deadLetter: {
        id: 'orig-env-1', from: 'agent:sender', to: 'agent:gone', kind: 'task',
        priority: over.priority ?? 'P1', correlationId: 'corr-dead-1',
        reason: over.reason ?? 'exhausted', deadLetteredAt: now,
        attempts: Array.from({ length: over.attempts ?? 2 }, (_, i) => ({
          attempt: i + 1, transport: 'fake-transport', outcome: 'retryable', at: now - i * 1000,
        })),
      },
      payloadDropped: over.payloadDropped ?? false,
      envelope: over.withPayload === false ? null : {
        id: 'orig-env-1', from: 'agent:sender', to: 'agent:gone', kind: 'task',
        priority: over.priority ?? 'P1', body: { kind: 'work', text: 'fake lost work' },
        correlationId: 'corr-dead-1', ttlMs: 3_600_000,
      },
    },
  });
  const postLetter = (body: unknown, extra: { priority?: 'P0' | 'P1' | 'P2' | 'P3'; ttl?: number; at?: number } = {}) =>
    postV2Body(body as BusJsonValue, { from: 'bus-router', to: 'bus.dead-letter', ...extra });

  it('lists a dead letter with its failure facts and inspect acts', async () => {
    const id = postLetter(deadLetterBody());
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual([`bus-dead-letter:${id}`]);
    expect(items[0]).toMatchObject({
      kind: 'bus-dead-letter', severity: 'warn', blocking: false,
      title: 'dead letter exhausted: agent:sender → agent:gone',
      detail: 'reason exhausted · 2 attempts · kind task · original orig-env-1 · correlation corr-dead-1 · cursor 1',
      since: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 3_600_000).toISOString(),
      act: [`phm agents bus show ${id}`, 'phm comms bus read --to bus.dead-letter'],
    });
    expect(items[0]!.jobIds).toBeUndefined();
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
  });

  it('reports the reason and parties the letter kept, high on an original P0', async () => {
    const noRoute = postLetter(deadLetterBody({ reason: 'no-route', priority: 'P0', attempts: 0 }), { priority: 'P0' });
    const dropped = postLetter(deadLetterBody({ reason: 'expired', payloadDropped: true, withPayload: false }));
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items).toHaveLength(2);
    const first = items.find(i => i.id === `bus-dead-letter:${noRoute}`)!;
    const second = items.find(i => i.id === `bus-dead-letter:${dropped}`)!;
    expect(first).toMatchObject({
      kind: 'bus-dead-letter', severity: 'high',
      title: 'dead letter no-route: agent:sender → agent:gone',
    });
    expect(first.detail).toContain('0 attempts');
    expect(second).toMatchObject({ severity: 'warn', title: 'dead letter expired: agent:sender → agent:gone' });
    expect(second.detail).toContain('original payload dropped');
    // The correlation id lives on the letter's own protocol body, so it
    // survives the original payload being dropped.
    expect(second.detail).toContain('correlation corr-dead-1');
  });

  it('lists an addressed envelope whose payload never parsed, honestly thin', async () => {
    // Anything on the reserved sink address is a delivery report; a body
    // without the deadLetter summary keeps unknowns out of the text.
    const id = postLetter({ kind: 'note', text: 'fake unparsed report' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === `bus-dead-letter:${id}`)!;
    expect(item).toMatchObject({
      kind: 'bus-dead-letter', severity: 'warn',
      title: 'dead letter: delivery failure',
      detail: 'cursor 1',
    });
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
  });

  it('drops an expired letter and never mistakes one for claimable work', async () => {
    postLetter(deadLetterBody(), { ttl: 1, at: now - 10_000 });
    const live = postLetter(deadLetterBody());
    postWork('still-work');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id).sort()).toEqual([`bus-dead-letter:${live}`, 'bus:still-work']);
    expect(items.find(i => i.id === `bus-dead-letter:${live}`)).toMatchObject({ kind: 'bus-dead-letter' });
    expect(items.find(i => i.id === 'bus:still-work')).toMatchObject({ kind: 'bus-work' });
  });

  it('filters by its own kind without joining --job or the work kinds', async () => {
    const id = postLetter(deadLetterBody());
    postWork('kind-work-neighbor');
    const letters = await read({ filter: { kind: 'bus-dead-letter' } });
    expect(letters.items.map(i => i.id)).toEqual([`bus-dead-letter:${id}`]);
    expect(letters.items[0]!.source).toBe('bus');
    // A dead letter names no job citation, so --job never claims one.
    const byJob = await read({ filter: { kind: 'bus-dead-letter', job: 'RQ-NOTHING' } });
    expect(byJob.total).toBe(0);
    const work = await read({ filter: { kind: 'bus-work' } });
    expect(work.items.map(i => i.id)).toEqual(['bus:kind-work-neighbor']);
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
    // A fully held job has no feed item and no claim act — the unanswered
    // announcement is exactly what this source exists to surface.
    postJob('RQ-HELD', { claimKeys: ['queue:RQ-HELD'], to: 'agent:worker' });
    holdKey('queue:RQ-HELD');
    postV2Body({ kind: 'work.post', jobId: 'RQ-SILENT', title: 'fake silent job', provider: 'codex-cmp',
      repo: 'ashlrai/phantom', claimKeys: [] }, { from: 'agent:peer', to: 'agent:worker' });
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'conversations:job:RQ-HELD')!;
    expect(item).toMatchObject({ kind: 'agent-thread', severity: 'info', source: 'conversations' });
    expect(item.act).toContain('phm agents bus post --to <sender-label> --text "<reply>" --thread job:RQ-HELD');
    // The unclaimable zero-key announcement is covered by its feed item
    // instead — one pending thing, one item.
    expect(inbox.items.find(i => i.id === 'bus-feed:RQ-SILENT')).toBeDefined();
    expect(inbox.items.find(i => i.id === 'conversations:job:RQ-SILENT')).toBeUndefined();
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 1 });
  });

  it('lists blocked threads as warn items naming who reported and who was told', async () => {
    const id = postV2Body({ kind: 'work.status', status: 'blocked', detail: 'waiting on creds', thread: 'ops-4' },
      { from: 'agent:worker-9', to: 'agent:lead', at: now - 7_200_000 });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'conversations');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'conversations:ops-4', kind: 'agent-thread', severity: 'warn', blocking: false,
      title: 'blocked: waiting on creds',
      detail: 'from worker-9 · to lead · blocked for 2h 0m · 1 message',
      since: new Date(now - 7_200_000).toISOString(),
      expiresAt: null,
      act: ['phm agents conversations', `phm agents bus show ${id}`,
        'phm agents bus post --to <sender-label> --text "<reply>" --thread ops-4'],
    });
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 1 });
  });

  it('lists waiting and blocked threads side by side', async () => {
    ask('can you review the diff?', 'review-9');
    postV2Body({ kind: 'work.status', status: 'failed', detail: 'tests red', thread: 'deploy-2' },
      { from: 'agent:worker', to: 'agent:lead' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'conversations').map(i => i.id).sort())
      .toEqual(['conversations:deploy-2', 'conversations:review-9']);
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 2 });
  });

  it('clears the blocked item once a later message moves the thread', async () => {
    postV2Body({ kind: 'work.status', jobId: 'RQ-BLK-3', status: 'blocked' },
      { from: 'agent:worker', to: 'agent:lead', at: now - 2_000 });
    postV2Body({ kind: 'work.status', jobId: 'RQ-BLK-3', status: 'done' },
      { from: 'agent:worker', to: 'agent:lead', at: now - 1_000 });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'conversations')).toHaveLength(0);
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 0 });
  });

  it('keeps one item when the feed already lists the blocked job thread', async () => {
    postJob('RQ-BLK-2', { claimKeys: ['queue:RQ-BLK-2'], to: 'agent:worker' });
    postV2Body({ kind: 'work.status', jobId: 'RQ-BLK-2', status: 'blocked', detail: 'waiting on creds' },
      { from: 'agent:peer', to: 'agent:lead' });
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus-feed:RQ-BLK-2']);
    expect(inbox.items.filter(i => i.source === 'conversations')).toHaveLength(0);
    expect(inbox.sources.conversations).toEqual({ state: 'healthy', pending: 0 });
  });

  it('reports unavailable and degraded reads honestly and uses the seam', async () => {
    const convStub = (over: Partial<AgentConversations>): AgentConversations => ({
      schema: 'agents.conversations.v1', version: 1, generatedAt: new Date(now).toISOString(),
      source: 'available', conversations: [], matched: 0, waiting: 0, skipped: 0, ...over,
    });
    const seen: unknown[] = [];
    const degraded = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readConversations: (query) => { seen.push(query); return convStub({ skipped: 2 }); } });
    expect(seen).toEqual([{}]);
    expect(degraded.sources.conversations).toEqual({ state: 'degraded', pending: 0 });
    const unavailable = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readConversations: () => convStub({ source: 'unavailable', conversations: null, matched: null, waiting: null }) });
    expect(unavailable.sources.conversations).toEqual({ state: 'unavailable', pending: null });
    const throwing = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readConversations: () => { throw new Error('boom'); } });
    expect(throwing.sources.conversations).toEqual({ state: 'unavailable', pending: null });
  });
});

describe('wake hints in the unified inbox', () => {
  const wakeRow = (id: string, to: string, at: number, extra: Partial<AgentWakeRow> = {}): AgentWakeRow =>
    ({ id, from: 'agent:peer', to, kind: 'bus.send', at, ...extra });
  const wakesPage = (wakes: AgentWakeRow[]): AllWakesPage =>
    ({ status: 'ok', scope: 'fleet', wakes, matched: wakes.length, truncated: false });
  const resolvedMsg = (summary: string, jobId?: string): AgentWakeRow['message'] => ({
    status: 'resolved', id: 'env-1', ts: new Date(now).toISOString(), priority: 'P2',
    from: 'agent:peer', to: 'agent:helper', channel: null, fromAgent: null, summary,
    ...(jobId === undefined ? {} : { job: { jobId, feed: 'ok' as const, job: null } }),
  });

  it('groups pending wake hints by addressee into one warn item each', async () => {
    registerAgentIdentity({ handle: 'helper', aliases: ['helper-alias'] }, { root: busRoot });
    const inbox = await read({
      readWakes: () => wakesPage([
        wakeRow('m-1', 'agent:helper', now - 7_200_000, { message: resolvedMsg('review the diff') }),
        wakeRow('m-2', 'helper', now - 3_600_000, { message: resolvedMsg('check the feed') }),
        wakeRow('m-3', 'helper-alias', now - 1_800_000),
        wakeRow('m-4', 'worker-9', now - 900_000),
      ]),
    });
    const items = inbox.items.filter(i => i.source === 'wakes');
    // helper's three label spellings merge into one identity group; the
    // unregistered worker-9 stays a literal-label group.
    expect(items).toHaveLength(2);
    const helper = items.find(i => i.title.includes('helper'))!;
    expect(helper).toMatchObject({
      kind: 'wake-hint', severity: 'warn', blocking: false,
      title: '3 pending wake hints for helper',
      since: new Date(now - 1_800_000).toISOString(), expiresAt: null,
    });
    expect(helper.detail).toContain('"review the diff"');
    expect(helper.act).toEqual(['phm agents bus wakes helper', 'phm agents bus wakes --all']);
    const worker = items.find(i => i.title.includes('worker-9'))!;
    expect(worker).toMatchObject({ title: '1 pending wake hint for worker-9', kind: 'wake-hint' });
    expect(inbox.sources.wakes).toEqual({ state: 'healthy', pending: 2 });
  });

  it('carries provable job citations so --job finds the hint', async () => {
    const page = wakesPage([
      wakeRow('wh-1', 'agent:helper', now - 3_600_000, {
        claimHolder: { statusId: 'st-1', jobId: 'RQ-WAKE-1', status: 'done', priority: 'P2' } }),
      wakeRow('m-2', 'agent:helper', now - 1_800_000, { message: resolvedMsg('feed says ship', 'RQ-WAKE-2') }),
      wakeRow('m-3', 'agent:helper', now - 900_000, { message: resolvedMsg('no job here') }),
    ]);
    const inbox = await read({ readWakes: () => page });
    const item = inbox.items.find(i => i.source === 'wakes')!;
    expect(item.jobIds).toEqual(['RQ-WAKE-1', 'RQ-WAKE-2']);
    const byJob = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      readWakes: () => page, filter: { job: 'RQ-WAKE-1' } });
    expect(byJob.items.filter(i => i.source === 'wakes')).toHaveLength(1);
    expect(byJob.items.find(i => i.source === 'wakes')!.jobIds).toContain('RQ-WAKE-1');
  });

  it('reports the wakes source unavailable when the fleet read cannot resolve', async () => {
    const inbox = await read({ readWakes: () => ({ status: 'unavailable', reason: 'registry unreadable' }) });
    expect(inbox.sources.wakes).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'wakes')).toHaveLength(0);
    const throwing = await read({ readWakes: () => { throw new Error('boom'); } });
    expect(throwing.sources.wakes).toEqual({ state: 'unavailable', pending: null });
  });

  it('reports a readable empty wake queue as healthy with nothing pending', async () => {
    const inbox = await read({ readWakes: () => wakesPage([]) });
    expect(inbox.sources.wakes).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'wakes')).toHaveLength(0);
  });

  it('degrades the wakes source when the bounded queue tail cut hints', async () => {
    const page: AllWakesPage = { status: 'ok', scope: 'fleet',
      wakes: [wakeRow('m-1', 'agent:helper', now - 900_000)],
      matched: 1, truncated: true };
    const inbox = await read({ readWakes: () => page });
    // The found group still lists and counts; degraded flags the partial read
    // the same way mailbox/board/conversations degrade on their own caps.
    expect(inbox.sources.wakes).toEqual({ state: 'degraded', pending: 1 });
    expect(inbox.items.filter(i => i.source === 'wakes')).toHaveLength(1);
  });

  it('degrades the wakes source when matched hints exceed the shown slice', async () => {
    const page: AllWakesPage = { status: 'ok', scope: 'fleet',
      wakes: [wakeRow('m-1', 'agent:helper', now - 900_000),
        wakeRow('m-2', 'agent:helper', now - 1_800_000)],
      matched: 9, truncated: false };
    const inbox = await read({ readWakes: () => page });
    expect(inbox.sources.wakes).toEqual({ state: 'degraded', pending: 1 });
    expect(inbox.items.filter(i => i.source === 'wakes')).toHaveLength(1);
  });

  it('honors source, kind, since and contains filters on wake items', async () => {
    const page = wakesPage([
      wakeRow('m-1', 'agent:helper', now - 7_200_000, { message: resolvedMsg('old ping') }),
      wakeRow('m-2', 'agent:helper', now - 900_000, { message: resolvedMsg('fresh ping about the release') }),
    ]);
    const readWakes = () => page;
    const base = { runsDir, busRoot, now: () => now, readRequests: () => ({ status: 'missing' as const, requests: [] }), readWakes };
    const bySource = await readUnifiedInbox({ ...base, filter: { source: 'wakes' } });
    expect(bySource.items.every(i => i.source === 'wakes')).toBe(true);
    expect(bySource.items.filter(i => i.source === 'wakes')).toHaveLength(1);
    const byKind = await readUnifiedInbox({ ...base, filter: { kind: 'wake-hint' } });
    expect(byKind.items.filter(i => i.source === 'wakes')).toHaveLength(1);
    const bySince = await readUnifiedInbox({ ...base, filter: { since: now - 1_000_000 } });
    expect(bySince.items.filter(i => i.source === 'wakes')).toHaveLength(1);
    const tooNew = await readUnifiedInbox({ ...base, filter: { since: now - 500_000 } });
    expect(tooNew.items.filter(i => i.source === 'wakes')).toHaveLength(0);
    const byContains = await readUnifiedInbox({ ...base, filter: { contains: 'release' } });
    expect(byContains.items.filter(i => i.source === 'wakes')).toHaveLength(1);
    const missContains = await readUnifiedInbox({ ...base, filter: { contains: 'nonexistent-needle' } });
    expect(missContains.items.filter(i => i.source === 'wakes')).toHaveLength(0);
  });
});

describe('bot seat handoffs in the unified inbox', () => {
  const handoff = (seatId: string, kind: 'bus-claim' | 'node-job', ref: string, n = 0): SeatHandoff => ({
    schema: 'phantom-bot-handoff.v1', handoffId: `h-${seatId}-${n}`,
    seatId, work: { kind, ref }, done: 'unknown', left: 'unknown',
    branch: null, pr: null, createdAt: new Date(now).toISOString(),
  });
  const seat = (over: Partial<SeatHandoffPlanEntry> = {}): SeatHandoffPlanEntry => ({
    seatId: 'devin-review', state: 'draining', eligible: true,
    handoffs: [handoff('devin-review', 'bus-claim', 'queue:RQ-SEAT-1')], ...over,
  });
  const plan = (seats: SeatHandoffPlanEntry[]): SeatHandoffsPlan =>
    ({ schema: 'phantom-bot-handoffs-plan.v1', apply: false, seats });
  const readSeats = (seats: SeatHandoffPlanEntry[]) => readUnifiedInbox({
    runsDir, busRoot, now: () => now,
    readSeatHandoffs: async () => plan(seats),
    readRequests: () => ({ status: 'missing', requests: [] }),
  });

  it('lists eligible seats with pending handoffs as warn items with plan and apply acts', async () => {
    const inbox = await readSeats([
      seat({ seatId: 'devin-review', state: 'draining',
        handoffs: [handoff('devin-review', 'bus-claim', 'queue:RQ-SEAT-1'),
                   handoff('devin-review', 'node-job', 'job-77', 1)] }),
      // An eligible seat with nothing pending is already on its way to idle,
      // not pending work; an ineligible seat's held work is not a candidate.
      seat({ seatId: 'idle-seat', state: 'idle', eligible: true, handoffs: [] }),
      seat({ seatId: 'active-seat', state: 'active', eligible: false,
        handoffs: [handoff('active-seat', 'bus-claim', 'queue:RQ-X')] }),
    ]);
    const items = inbox.items.filter(i => i.source === 'seats');
    expect(items.map(i => i.id)).toEqual(['seats:devin-review']);
    expect(items[0]).toMatchObject({
      kind: 'seat-handoff', severity: 'warn', blocking: false, priority: 'today',
      title: 'Seat devin-review (draining): 2 pending handoffs',
      detail: 'draining · bus-claim queue:RQ-SEAT-1, node-job job-77',
      since: null, expiresAt: null,
      act: ['phm bots handoff --seat devin-review', 'phm bots handoff --seat devin-review --apply', 'phm bots handoffs'],
    });
    expect(inbox.sources.seats).toEqual({ state: 'healthy', pending: 1 });
  });

  it('lists one item per seat and clips the detail ref list with an overflow count', async () => {
    const handoffs = Array.from({ length: 6 }, (_, i) => handoff('devin-review', 'bus-claim', `queue:RQ-${i}`, i));
    const inbox = await readSeats([
      seat({ handoffs }),
      seat({ seatId: 'codex-fast', state: 'idle',
        handoffs: [handoff('codex-fast', 'node-job', 'job-1', 1), handoff('codex-fast', 'node-job', 'job-2', 2)] }),
    ]);
    expect(inbox.items.filter(i => i.source === 'seats').map(i => i.id).sort()).toEqual(['seats:codex-fast', 'seats:devin-review']);
    expect(inbox.sources.seats).toEqual({ state: 'healthy', pending: 2 });
    const item = inbox.items.find(i => i.id === 'seats:devin-review')!;
    expect(item.title).toBe('Seat devin-review (draining): 6 pending handoffs');
    expect(item.detail).toBe('draining · bus-claim queue:RQ-0, bus-claim queue:RQ-1, bus-claim queue:RQ-2, bus-claim queue:RQ-3 +2 more');
  });

  it('reports an empty roster as missing and a throwing read as unavailable while other sources still list', async () => {
    const empty = await readSeats([]);
    expect(empty.sources.seats).toEqual({ state: 'missing', pending: 0 });
    expect(empty.items.filter(i => i.source === 'seats')).toHaveLength(0);
    const throwing = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readSeatHandoffs: () => { throw new Error('boom'); },
      readRequests: () => ({ status: 'missing', requests: [] }) });
    expect(throwing.sources.seats).toEqual({ state: 'unavailable', pending: null });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const mixed = await readSeats([seat()]);
    expect(mixed.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
    expect(mixed.items.filter(i => i.source === 'seats').map(i => i.id)).toEqual(['seats:devin-review']);
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
    expect(inbox.sources['owner-thread']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'owner-thread')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('degrades on a throwing seam and builds items from a stubbed read', async () => {
    const throwing = await readUnifiedInbox({ runsDir, busRoot, now: () => now, readOwnerAwaiting: () => { throw new Error('boom'); } });
    expect(throwing.sources['owner-thread']).toEqual({ state: 'unavailable', pending: null });
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

describe('owner-delivery undelivered replies in the unified inbox', () => {
  const ownerSettings: OwnerThreadSettings = {
    ...emptyOwnerSettings(),
    owners: { desktop: 'local-owner' },
    confirmed: true,
    team: [{ channel: 'bus', id: 'local-owner' }],
  };
  const ownerOptions = (over: Partial<OwnerThreadOptions> = {}): OwnerThreadOptions => ({
    runsDir, busRoot, now: () => now, settings: ownerSettings, halted: false, paused: false,
    mailbox: { async accept() { return { status: 'accepted' as const }; } },
    ...over,
  });
  const acceptOwner = (text: string, key: string, at = now) => acceptOwnerInbound(
    { channel: 'desktop', senderId: 'local-owner', text, idempotencyKey: key, at }, ownerOptions());

  it('lists a recorded reply no channel confirmed as a warn item with a resend deep link', async () => {
    await acceptOwner('ping the leader', 'desktop-msg-0001');
    // No transports attached: the reply records as refused on every fanout
    // destination yet still answers the inbound — the delivery gap this lists.
    const reply = await sendOwnerReply({ text: 'leader answer', replyTo: 'desktop-msg-0001', idempotencyKey: 'reply-owner-01' }, ownerOptions());
    expect(reply.status).toBe('refused');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'owner-delivery');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'owner-delivery:m2', kind: 'owner-reply-undelivered', severity: 'warn', blocking: false,
      title: 'Leader reply undelivered on desktop',
      detail: 'desktop: failed (No transport is attached for this channel.) · "leader answer"',
      since: new Date(now).toISOString(),
      expiresAt: null,
      act: ['phm comms thread', 'phm comms send-owner --reply-to desktop-msg-0001 --idempotency-key reply-owner-01 --text "<same reply text>"'],
    });
    expect(inbox.sources['owner-delivery']).toEqual({ state: 'healthy', pending: 1 });
    // The answered inbound itself stays cleared — the two marks are independent.
    expect(inbox.items.filter(i => i.source === 'owner-thread')).toHaveLength(0);
  });

  it('clears the item once a resend confirms the destination', async () => {
    await acceptOwner('ping the leader', 'desktop-msg-0001');
    await sendOwnerReply({ text: 'leader answer', replyTo: 'desktop-msg-0001', idempotencyKey: 'reply-owner-01' }, ownerOptions());
    expect((await read()).items.filter(i => i.source === 'owner-delivery')).toHaveLength(1);
    const retry = await sendOwnerReply({ text: 'leader answer', replyTo: 'desktop-msg-0001', idempotencyKey: 'reply-owner-01' }, ownerOptions({
      transports: { desktop: { async pull() { return []; }, async deliver() { return { status: 'sent' as const, reason: 'ok' }; } } },
    }));
    expect(retry.status).toBe('sent');
    const inbox = await read();
    expect(inbox.items.filter(i => i.source === 'owner-delivery')).toHaveLength(0);
    expect(inbox.sources['owner-delivery']).toEqual({ state: 'healthy', pending: 0 });
  });

  it('reports an unreadable thread as unavailable and still lists the other sources', async () => {
    mkdirSync(join(runsDir, 'leader'), { recursive: true });
    writeFileSync(join(runsDir, 'leader', 'owner-thread.json'), 'not json', { mode: 0o600 });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await read();
    expect(inbox.sources['owner-delivery']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'owner-delivery')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('degrades on a throwing seam and builds items from a stubbed read', async () => {
    const throwing = await readUnifiedInbox({ runsDir, busRoot, now: () => now, readOwnerUndelivered: () => { throw new Error('boom'); } });
    expect(throwing.sources['owner-delivery']).toEqual({ state: 'unavailable', pending: null });
    const stubbed = await readUnifiedInbox({
      runsDir, busRoot, now: () => now,
      readOwnerUndelivered: () => ({ status: 'ok', items: [
        { id: 'm7', idempotencyKey: 'reply-owner-07', replyTo: 'desktop-msg-0007',
          at: new Date(now - 60_000).toISOString(), text: 'stubbed answer',
          destinations: [{ channel: 'telegram' as const, state: 'unknown' as const, reason: null }] },
        { id: 'm8', idempotencyKey: 'reply-owner-08', replyTo: 'not a valid key!',
          at: new Date(now - 30_000).toISOString(), text: 'stubbed answer two',
          destinations: [{ channel: 'slack' as const, state: 'failed' as const, reason: 'stub reason' }] },
      ] }),
    });
    const good = stubbed.items.find(i => i.id === 'owner-delivery:m7')!;
    expect(good).toMatchObject({
      kind: 'owner-reply-undelivered', severity: 'warn', blocking: false,
      title: 'Leader reply undelivered on telegram',
      detail: 'telegram: unknown · "stubbed answer"',
      act: ['phm comms thread', 'phm comms send-owner --reply-to desktop-msg-0007 --idempotency-key reply-owner-07 --text "<same reply text>"'],
    });
    // A replyTo that fails the send-owner shape guard keeps the inspect link only.
    const guarded = stubbed.items.find(i => i.id === 'owner-delivery:m8')!;
    expect(guarded.act).toEqual(['phm comms thread']);
    expect(stubbed.sources['owner-delivery']).toEqual({ state: 'healthy', pending: 2 });
  });
});

describe('needs-you reply deliveries in the unified inbox', () => {
  const failingInbox = async () => ({ ok: false as const, reason: 'write-failed' as const });
  const deliveryOptions = () => ({ runsDir, bus: { root: busRoot, now: () => now }, now: () => now });

  it('lists a recorded answer not confirmed in the planner inbox with a retry deep link', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- Pick a fake color\n');
    const itemId = listNeedsMason({ runsDir })[0]!.id;
    // The durable resolution succeeds but the planner-inbox append fails, so
    // the receipt stays pending — the resolved item itself leaves needs-you.
    const resolved = await resolveNeedsMasonWithInbox(
      { itemId, reply: 'Use fake blue' }, { ...deliveryOptions(), appendInbox: failingInbox });
    expect(resolved).toMatchObject({ ok: true, inbox: 'failed' });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'needs-you-delivery');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `needs-you-delivery:${itemId}`, kind: 'needs-you-delivery', severity: 'warn', blocking: false,
      title: `Needs-you answer ${itemId} not confirmed in the planner inbox`,
      detail: 'via Phantom desktop · "Pick a fake color"',
      since: null, expiresAt: null,
      act: [`phm fleet needs-resolve ${itemId}`, 'phm fleet needs'],
    });
    expect(inbox.sources['needs-you-delivery']).toEqual({ state: 'healthy', pending: 1 });
    // The resolved ledger line is gone from needs-you: one pending thing, one item.
    expect(inbox.sources['needs-you']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(0);
  });

  it('keeps delivered receipts and a missing directory out of the list', async () => {
    // No needs-mason-delivery directory at all: a verified-empty read.
    expect((await read()).sources['needs-you-delivery']).toEqual({ state: 'healthy', pending: 0 });
    writeDelivery(runsDir, 'nm-aaaaaaaaaaaa', { status: 'delivered', message: '', source: 'CLI', cursor: 0, duplicate: false });
    writeDelivery(runsDir, 'nm-bbbbbbbbbbbb', { status: 'pending', message: 'Re needs-you nm-bbbbbbbbbbbb: hi', source: 'CLI', cursor: 0, duplicate: false });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'needs-you-delivery');
    expect(items.map(i => i.id)).toEqual(['needs-you-delivery:nm-bbbbbbbbbbbb']);
    expect(items[0]).toMatchObject({ detail: 'via CLI · ledger text unknown' });
    expect(inbox.sources['needs-you-delivery']).toEqual({ state: 'healthy', pending: 1 });
  });

  it('lists an unsafe receipt as unreadable with its delivery state unknown', async () => {
    mkdirSync(join(runsDir, 'needs-mason-delivery'), { recursive: true });
    writeFileSync(join(runsDir, 'needs-mason-delivery', 'nm-eeeeeeeeeeee.json'), '{not json');
    const inbox = await read();
    const item = inbox.items.find(i => i.id === 'needs-you-delivery:nm-eeeeeeeeeeee')!;
    expect(item).toMatchObject({
      kind: 'needs-you-delivery', severity: 'warn', blocking: false,
      title: 'Needs-you delivery receipt nm-eeeeeeeeeeee unreadable',
      act: ['phm fleet needs'],
    });
    expect(inbox.sources['needs-you-delivery']).toEqual({ state: 'healthy', pending: 1 });
  });

  it('reports an unreadable delivery store as unavailable and still lists the other sources', async () => {
    writeFileSync(join(runsDir, 'needs-mason-delivery'), 'not a dir');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await read();
    expect(inbox.sources['needs-you-delivery']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'needs-you-delivery')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('degrades on a throwing seam and builds items from a stubbed read', async () => {
    const throwing = await readUnifiedInbox({ runsDir, busRoot, now: () => now, readNeedsDeliveries: () => { throw new Error('boom'); } });
    expect(throwing.sources['needs-you-delivery']).toEqual({ state: 'unavailable', pending: null });
    const stubbed = await readUnifiedInbox({
      runsDir, busRoot, now: () => now,
      readNeedsDeliveries: () => ({ status: 'ok',
        pending: [
          { itemId: 'nm-0123456789ab', source: 'CLI', text: 'fake question' },
          { itemId: 'nm-111111111111', source: 'Telegram', text: null },
        ],
        unsafe: ['nm-ffffffffffff'], delivered: 2 }),
    });
    const pending = stubbed.items.find(i => i.id === 'needs-you-delivery:nm-0123456789ab')!;
    expect(pending).toMatchObject({
      kind: 'needs-you-delivery', severity: 'warn', blocking: false,
      title: 'Needs-you answer nm-0123456789ab not confirmed in the planner inbox',
      detail: 'via CLI · "fake question"',
      act: ['phm fleet needs-resolve nm-0123456789ab', 'phm fleet needs'],
    });
    // A ledger line the read could not join stays unknown, never guessed.
    const unknown = stubbed.items.find(i => i.id === 'needs-you-delivery:nm-111111111111')!;
    expect(unknown.detail).toBe('via Telegram · ledger text unknown');
    const unsafe = stubbed.items.find(i => i.id === 'needs-you-delivery:nm-ffffffffffff')!;
    expect(unsafe).toMatchObject({
      title: 'Needs-you delivery receipt nm-ffffffffffff unreadable', act: ['phm fleet needs'],
    });
    expect(stubbed.sources['needs-you-delivery']).toEqual({ state: 'healthy', pending: 3 });
  });
});

describe('readUnifiedInbox comms requests', () => {
  const TTL = 48 * 3_600_000;
  const req = (over: Partial<CommsRequest> = {}): CommsRequest => ({
    id: 'req-1', kind: 'manager-approval', type: 'approval',
    text: 'Merge "fake change" → repo? Judged SHIP (v9/c9/s9/a9).',
    options: ['Approve & merge', 'Reject', 'Show diff'],
    status: 'sent',
    createdAt: new Date(now - 3 * 3_600_000).toISOString(),
    sentAt: new Date(now - 2 * 3_600_000).toISOString(),
    ...over,
  });
  const available = (requests: CommsRequest[]): CommsRequestsRead => ({ status: 'available', requests });
  const readReq = (read: () => CommsRequestsRead) =>
    readUnifiedInbox({ runsDir, busRoot, now: () => now, requestTtlMs: TTL, readRequests: read });

  it('lists a sent approval as a blocking warn with real expiry and deep links', async () => {
    const r = req({ meta: { proposalId: 'prop-m1abc000-000001-abcdef0123456789abcdef' } });
    const inbox = await readReq(() => available([r]));
    const item = inbox.items.find(i => i.id === 'requests:req-1')!;
    expect(item).toMatchObject({
      source: 'requests', kind: 'comms-request', severity: 'warn', blocking: true, priority: 'now',
      title: 'Merge "fake change" → repo? Judged SHIP (v9/c9/s9/a9).',
      detail: 'approval · manager-approval · awaiting reply · 3 options · waiting 2h 0m',
      since: r.sentAt,
      expiresAt: new Date(Date.parse(r.sentAt!) + TTL).toISOString(),
      act: ['phm comms status', 'phm inbox show prop-m1abc000-000001-abcdef0123456789abcdef'],
    });
    expect(inbox.sources.requests).toEqual({ state: 'healthy', pending: 1 });
  });

  it('skips malformed store rows instead of crashing the inbox', async () => {
    const inbox = await readReq(() => available([null as unknown as CommsRequest, req()]));
    const items = inbox.items.filter(i => i.source === 'requests');
    expect(items.map(i => i.id)).toEqual(['requests:req-1']);
    expect(inbox.sources.requests).toEqual({ state: 'healthy', pending: 1 });
  });

  it('lists a pending question as a queued info item and never lists reports or resolved requests', async () => {
    const pending = req({ id: 'req-q', kind: 'leader-question', type: 'question', status: 'pending',
      sentAt: undefined, createdAt: new Date(now - 30 * 60_000).toISOString() });
    const report = req({ id: 'req-r', type: 'report', kind: 'fleet-digest', status: 'pending', options: [], sentAt: undefined });
    const answered = req({ id: 'req-a', status: 'answered' });
    const expired = req({ id: 'req-e', status: 'expired' });
    const inbox = await readReq(() => available([pending, report, answered, expired]));
    const items = inbox.items.filter(i => i.source === 'requests');
    expect(items.map(i => i.id)).toEqual(['requests:req-q']);
    expect(items[0]).toMatchObject({
      severity: 'info', blocking: false, priority: 'this-week',
      detail: 'question · leader-question · queued · 3 options · waiting 30m',
      since: pending.createdAt,
      expiresAt: new Date(Date.parse(pending.createdAt) + TTL).toISOString(),
      act: ['phm comms status'],
    });
    expect(inbox.sources.requests).toEqual({ state: 'healthy', pending: 1 });
  });

  it('reports missing, unavailable and throwing reads honestly', async () => {
    const missing = await readReq(() => ({ status: 'missing', requests: [] }));
    expect(missing.sources.requests).toEqual({ state: 'missing', pending: 0 });
    const unavailable = await readReq(() => ({ status: 'unavailable', requests: [] }));
    expect(unavailable.sources.requests).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'requests')).toHaveLength(0);
    const throwing = await readReq(() => { throw new Error('boom'); });
    expect(throwing.sources.requests).toEqual({ state: 'unavailable', pending: null });
  });

  it('treats an available-but-empty queue as healthy zero, not missing', async () => {
    const inbox = await readReq(() => available([]));
    expect(inbox.sources.requests).toEqual({ state: 'healthy', pending: 0 });
  });

  it('scrubs secret-shaped request text and never copies option labels', async () => {
    const r = req({ text: 'Approve key sk-abcdefghijklmnop\nnow', options: ['yes', 'no'] });
    const inbox = await readReq(() => available([r]));
    const item = inbox.items.find(i => i.source === 'requests')!;
    expect(item.title).toContain('[REDACTED]');
    expect(item.title).not.toContain('sk-abcdefghijklmnop');
    expect(item.title).not.toMatch(/\n/);
    expect(item.detail).toContain('2 options');
    expect(item.detail).not.toContain('yes');
  });

  it('does not deep-link a proposal id that fails the inbox-show shape guard', async () => {
    const r = req({ meta: { proposalId: 'bad id; touch /tmp/x' } });
    const inbox = await readReq(() => available([r]));
    expect(inbox.items.find(i => i.id === 'requests:req-1')!.act).toEqual(['phm comms status']);
  });

  it('leaves since and expiresAt unknown for an unparseable timestamp', async () => {
    const r = req({ createdAt: 'not-a-date', sentAt: 'also-bad' });
    const inbox = await readReq(() => available([r]));
    const item = inbox.items.find(i => i.id === 'requests:req-1')!;
    expect(item.since).toBeNull();
    expect(item.expiresAt).toBeNull();
    expect(item.detail).toBe('approval · manager-approval · awaiting reply · 3 options');
  });
});

describe('readUnifiedInbox email outbox', () => {
  const config = (over: Partial<EmailDropConfig> = {}): EmailDropConfig => ({
    v: 1, inboxDir: join(root, 'inbox'), outboxDir: join(root, 'outbox'),
    from: ['operator@example.test'], ...over,
  });
  /** A mixed outbox: three stuck artifacts and one row of every non-stuck state. */
  const seedOutbox = (): string => {
    const dir = join(root, 'outbox');
    for (const sub of ['sending', 'sent', 'drafted']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'queued.reply.eml'), 'To: person@example.com\nSubject: hi\n\nbody\n', { mode: 0o600 });
    writeFileSync(join(dir, 'big.reply.eml'), 'x'.repeat(EMAIL_OUTBOX_MAX_BYTES + 1), { mode: 0o600 });
    writeFileSync(join(dir, 'sending', 'lost.reply.eml'), 'To: person@example.com\nSubject: hi\n\nbody\n', { mode: 0o600 });
    writeFileSync(join(dir, 'sent', 'done.reply.eml'), 'x', { mode: 0o600 });
    writeFileSync(join(dir, 'drafted', 'good.reply.eml'), 'To: person@example.com\nSubject: hi\n\nbody\n', { mode: 0o600 });
    writeFileSync(join(dir, 'drafted', 'broken.reply.eml'), 'Subject: no recipient\n\nbody\n', { mode: 0o600 });
    return dir;
  };

  it('lists only stuck reply artifacts as warn items with the fixed reason and deep links', async () => {
    await writeEmailDropConfig(runsDir, config());
    seedOutbox();
    const inbox = await read();
    expect(inbox.sources['email-outbox']).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'email-outbox');
    expect(items).toHaveLength(3);
    expect(items.map(i => i.detail).sort()).toEqual(['reason interrupted-send', 'reason malformed', 'reason oversized']);
    const lost = items.find(i => i.id === outboxId('lost.reply.eml'))!;
    expect(lost).toMatchObject({
      kind: 'email-stuck', severity: 'warn', blocking: false, priority: 'today',
      title: 'Stuck email reply lost.reply.eml',
      since: null, expiresAt: null,
      act: ['phm fleet email-outbox', 'phm comms diagnose --json'],
    });
    // Queued, sent and drafted rows are the send pass's own concern — never items.
    expect(items.some(i => /queued|done|good/.test(i.title))).toBe(false);
  });

  it('resolves the outbox as the sibling of inboxDir when outboxDir is absent', async () => {
    await writeEmailDropConfig(runsDir, { v: 1, inboxDir: join(root, 'inbox'), from: ['operator@example.test'] });
    const dir = join(root, 'outbox'); // join(inboxDir, '..', 'outbox')
    mkdirSync(join(dir, 'sending'), { recursive: true });
    writeFileSync(join(dir, 'sending', 'lost.reply.eml'), 'x', { mode: 0o600 });
    const inbox = await read();
    expect(inbox.sources['email-outbox']).toEqual({ state: 'healthy', pending: 1 });
    expect(inbox.items.find(i => i.id === outboxId('lost.reply.eml'))).toMatchObject({ kind: 'email-stuck' });
  });

  it('reports missing config, invalid config, a missing outbox and a non-directory outbox honestly', async () => {
    expect((await read()).sources['email-outbox']).toEqual({ state: 'missing', pending: 0 });
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'email-drop.json'), '{oops', { mode: 0o600 });
    expect((await read()).sources['email-outbox']).toEqual({ state: 'degraded', pending: 0 });
    await writeEmailDropConfig(runsDir, config({ outboxDir: join(root, 'no-such-outbox') }));
    expect((await read()).sources['email-outbox']).toEqual({ state: 'missing', pending: 0 });
    const file = join(root, 'outbox-is-a-file');
    writeFileSync(file, 'x', { mode: 0o600 });
    await writeEmailDropConfig(runsDir, config({ outboxDir: file }));
    expect((await read()).sources['email-outbox']).toEqual({ state: 'unavailable', pending: null });
  });

  it('builds items from an injected read and reports a throwing seam as unavailable while other sources list', async () => {
    const pinned = { readRequests: () => ({ status: 'missing' as const, requests: [] }) };
    const stubbed = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readEmailOutbox: async () => ({ state: 'healthy', entries: [
        { name: 'a.reply.eml', state: 'stuck', reason: 'oversized' },
        { name: 'b.reply.eml', state: 'queued' },
        { name: 'c.reply.eml', state: 'stuck' },
      ] }),
    });
    const items = stubbed.items.filter(i => i.source === 'email-outbox');
    expect(items.map(i => i.id).sort()).toEqual([outboxId('a.reply.eml'), outboxId('c.reply.eml')].sort());
    expect(items.find(i => i.id === outboxId('c.reply.eml'))!.detail).toBe('reason unknown');
    expect(stubbed.sources['email-outbox']).toEqual({ state: 'healthy', pending: 2 });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const throwing = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readEmailOutbox: async () => { throw new Error('boom'); },
    });
    expect(throwing.sources['email-outbox']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('scrubs secret-shaped artifact names out of the whole item', async () => {
    await writeEmailDropConfig(runsDir, config());
    const dir = join(root, 'outbox');
    mkdirSync(join(dir, 'sending'), { recursive: true });
    writeFileSync(join(dir, 'sending', 'sk-abcdefghijklmnop.reply.eml'), 'x', { mode: 0o600 });
    const item = (await read()).items.find(i => i.source === 'email-outbox')!;
    expect(item.title).toContain('[REDACTED]');
    expect(item.title).not.toContain('sk-abcdefghijklmnop');
    expect(item.title).not.toMatch(/\n/);
    // The opaque id and every other field must not echo the artifact name either.
    expect(JSON.stringify(item)).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('readUnifiedInbox email inbox', () => {
  const config = (over: Partial<EmailDropConfig> = {}): EmailDropConfig => ({
    v: 1, inboxDir: join(root, 'drop-inbox'), from: ['operator@example.test'], ...over,
  });
  const dropFile = (dir: string, name: string, at = '2026-11-07T10:00:00Z') => {
    writeFileSync(join(dir, name), 'From: a@b.c\r\n\r\nbody\r\n', { mode: 0o600 });
    const ms = Date.parse(at);
    utimesSync(join(dir, name), ms / 1000, ms / 1000);
  };
  const inboxId = (): string => `email-inbox:${createHash('sha256').update(runsDir).digest('hex').slice(0, 16)}`;

  it('lists the whole unprocessed .eml backlog as one warn item with the real count and newest mtime', async () => {
    const dir = join(root, 'drop-inbox');
    mkdirSync(dir, { recursive: true });
    await writeEmailDropConfig(runsDir, config());
    dropFile(dir, 'old.eml', '2026-11-06T09:00:00Z');
    dropFile(dir, 'new.eml', '2026-11-07T10:00:00Z');
    dropFile(dir, 'notes.txt');
    const inbox = await read();
    expect(inbox.sources['email-inbox']).toEqual({ state: 'healthy', pending: 1 });
    const items = inbox.items.filter(i => i.source === 'email-inbox');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: inboxId(), kind: 'email-inbound', severity: 'warn', blocking: false,
      title: '2 inbound email files awaiting ingestion',
      detail: null, since: '2026-11-07T10:00:00.000Z', expiresAt: null,
      act: ['phm comms email-cycle', 'phm comms diagnose --json'],
    });
    expect(items[0]!.jobIds).toBeUndefined();
  });

  it('reports missing config, invalid config, a missing inbox and a non-directory inbox honestly', async () => {
    expect((await read()).sources['email-inbox']).toEqual({ state: 'missing', pending: 0 });
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'email-drop.json'), '{oops', { mode: 0o600 });
    expect((await read()).sources['email-inbox']).toEqual({ state: 'degraded', pending: 0 });
    await writeEmailDropConfig(runsDir, config());
    expect((await read()).sources['email-inbox']).toEqual({ state: 'missing', pending: 0 });
    const file = join(root, 'inbox-is-a-file');
    writeFileSync(file, 'x', { mode: 0o600 });
    await writeEmailDropConfig(runsDir, config({ inboxDir: file }));
    expect((await read()).sources['email-inbox']).toEqual({ state: 'unavailable', pending: null });
  });

  it('degrades an other-writable inbox and annotates a paused config without hiding the count', async () => {
    const dir = join(root, 'drop-inbox');
    mkdirSync(dir, { recursive: true });
    dropFile(dir, 'a.eml');
    await writeEmailDropConfig(runsDir, config());
    chmodSync(dir, 0o777);
    const unsafe = await read();
    expect(unsafe.sources['email-inbox']).toEqual({ state: 'degraded', pending: 1 });
    expect(unsafe.items.find(i => i.source === 'email-inbox')!.detail).toContain('writable by other users');
    chmodSync(dir, 0o700);
    await writeEmailDropConfig(runsDir, config({ enabled: false }));
    const paused = await read();
    expect(paused.sources['email-inbox']).toEqual({ state: 'healthy', pending: 1 });
    expect(paused.items.find(i => i.source === 'email-inbox')!.detail).toContain('enabled:false');
  });

  it('reports an unreadable inbox as unavailable while other sources still list', async () => {
    const dir = join(root, 'drop-inbox');
    mkdirSync(dir, { recursive: true });
    dropFile(dir, 'a.eml');
    await writeEmailDropConfig(runsDir, config());
    chmodSync(dir, 0o000);
    try {
      writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
      const inbox = await read();
      expect(inbox.sources['email-inbox']).toEqual({ state: 'unavailable', pending: null });
      expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('builds the backlog item from an injected read and reports a throwing seam as unavailable', async () => {
    const pinned = { readRequests: () => ({ status: 'missing' as const, requests: [] }) };
    const stubbed = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readEmailInbox: async () => ({ state: 'healthy', pending: 3, since: '2026-11-07T11:00:00.000Z', unsafe: false, paused: false }),
    });
    const items = stubbed.items.filter(i => i.source === 'email-inbox');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: '3 inbound email files awaiting ingestion', since: '2026-11-07T11:00:00.000Z' });
    expect(stubbed.sources['email-inbox']).toEqual({ state: 'healthy', pending: 1 });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const throwing = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readEmailInbox: async () => { throw new Error('boom'); },
    });
    expect(throwing.sources['email-inbox']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('never lets a secret-shaped or address-carrying filename reach the item', async () => {
    const dir = join(root, 'drop-inbox');
    mkdirSync(dir, { recursive: true });
    await writeEmailDropConfig(runsDir, config());
    dropFile(dir, 'sk-abcdefghijklmnop@example.com.eml');
    const item = (await read()).items.find(i => i.source === 'email-inbox')!;
    expect(JSON.stringify(item)).not.toContain('sk-abcdefghijklmnop');
    expect(JSON.stringify(item)).not.toContain('example.com.eml');
    expect(item.title).not.toMatch(/\n/);
  });
});

describe('readUnifiedInbox team approvals', () => {
  const approval = (over: Partial<TeamApprovalItem> = {}): TeamApprovalItem => ({
    id: 'ev-abc123',
    kind: 'access',
    summary: 'Access request: repo write on ashlrai/phantom',
    requestedBy: 'agent:claude',
    note: 'needs triage access',
    command: `phm team approve ev-abc123 --team ${DEFAULT_TEAM}`,
    ...over,
  });
  const pinned = {
    readRequests: () => ({ status: 'missing' as const, requests: [] }),
    readInboxProposals: () => ({ state: 'ok' as const, items: [], truncated: false }),
  };

  it('lists pending approvals as blocking warn items with approve/deny links', async () => {
    const teams: string[] = [];
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readTeamApprovals: (team) => {
        teams.push(team);
        return { state: 'ok', items: [
          approval(),
          approval({
            id: 'ev-def456', kind: 'handoff', summary: 'Consequential action: rotate the deploy key',
            requestedBy: 'agent:codex', note: null, command: `phm team approve ev-def456 --team ${DEFAULT_TEAM}`,
          }),
        ] };
      },
    });
    expect(teams).toEqual([DEFAULT_TEAM]);
    expect(inbox.sources['team-approvals']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'team-approvals');
    expect(items).toHaveLength(2);
    const first = items.find(i => i.id === 'team-approvals:ev-abc123')!;
    expect(first).toMatchObject({
      kind: 'team-approval', severity: 'warn', blocking: true, priority: 'now',
      title: 'Access request: repo write on ashlrai/phantom',
      since: null, expiresAt: null,
      act: [
        'phm team approve ev-abc123 --team default',
        'phm team deny ev-abc123 --team default',
        'phm approvals',
      ],
    });
    expect(first.detail).toBe('from agent:claude · "needs triage access"');
    // The projection carries no timestamp, so the item invents none.
    expect(items.find(i => i.id === 'team-approvals:ev-def456')).toMatchObject({
      detail: 'from agent:codex', since: null, expiresAt: null,
    });
  });

  it('reports unavailable on a refused or throwing read while other sources still list', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const refused = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readTeamApprovals: (): Section<TeamApprovalItem> => ({ state: 'unavailable', reason: 'boom', items: [] }),
    });
    expect(refused.sources['team-approvals']).toEqual({ state: 'unavailable', pending: null });
    expect(refused.items.filter(i => i.source === 'team-approvals')).toHaveLength(0);
    expect(refused.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
    const throwing = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readTeamApprovals: () => { throw new Error('boom'); },
    });
    expect(throwing.sources['team-approvals']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });
});

describe('readUnifiedInbox inbox proposals', () => {
  const proposal = (over: Partial<ProposalApprovalItem> = {}): ProposalApprovalItem => ({
    id: 'prop-abc123',
    kind: 'outbound-email',
    title: 'Send follow-up to ops@example.com',
    detail: 'subject: fake subject',
    createdAt: '2026-11-06T12:00:00Z',
    partial: false,
    revision: 'approval-v1:abc',
    reviewPath: '/inbox/prop-abc123',
    ...over,
  });
  const section = (
    items: ProposalApprovalItem[],
    over: { state?: 'ok' | 'unavailable'; truncated?: boolean } = {},
  ): Section<ProposalApprovalItem> & { truncated: boolean } => ({
    state: over.state ?? 'ok',
    ...(over.state === 'unavailable' ? { reason: 'boom' } : {}),
    items,
    truncated: over.truncated ?? false,
  });
  const pinned = {
    readRequests: () => ({ status: 'missing' as const, requests: [] }),
    readTeamApprovals: (): Section<TeamApprovalItem> => ({ state: 'ok', items: [] }),
  };
  const readWith = (readInboxProposals: () => Section<ProposalApprovalItem> & { truncated: boolean }) =>
    readUnifiedInbox({ runsDir, busRoot, now: () => now, ...pinned, readInboxProposals });

  it('lists pending proposals as info items with review links and real timestamps', async () => {
    const inbox = await readWith(() => section([
      proposal(),
      proposal({
        id: 'prop-def456', kind: 'channel-post', title: 'Post the launch note', detail: null,
        createdAt: 'not-a-date', partial: true,
      }),
    ]));
    expect(inbox.sources.proposals).toEqual({ state: 'healthy', pending: 2 });
    const first = inbox.items.find(i => i.id === 'proposals:prop-abc123')!;
    expect(first).toMatchObject({
      kind: 'inbox-proposal', severity: 'info', blocking: false,
      title: 'Send follow-up to ops@example.com',
      detail: 'outbound-email proposal — subject: fake subject',
      since: '2026-11-06T12:00:00Z', expiresAt: null,
      act: ['phm inbox show prop-abc123', 'phm inbox approve prop-abc123', 'phm inbox reject prop-abc123'],
    });
    const partial = inbox.items.find(i => i.id === 'proposals:prop-def456')!;
    // A partial capture can be rejected but never approved.
    expect(partial.act).toEqual(['phm inbox show prop-def456', 'phm inbox reject prop-def456']);
    expect(partial.detail).toBe('channel-post proposal · partial capture');
    // An unparseable createdAt stays unknown — never invented.
    expect(partial.since).toBeNull();
  });

  it('keeps only the bare inbox link for a proposal id that fails the shape guard', async () => {
    const inbox = await readWith(() => section([proposal({ id: 'bad id; touch /tmp/x' })]));
    const item = inbox.items.find(i => i.source === 'proposals')!;
    expect(item.act).toEqual(['phm inbox']);
  });

  it('reports degraded on truncated or incomplete reads while listing what it found', async () => {
    const truncated = await readWith(() => section([proposal()], { truncated: true }));
    expect(truncated.sources.proposals).toEqual({ state: 'degraded', pending: 1 });
    expect(truncated.items.filter(i => i.source === 'proposals')).toHaveLength(1);
    const incomplete = await readWith(() => section([proposal()], { state: 'unavailable' }));
    expect(incomplete.sources.proposals).toEqual({ state: 'degraded', pending: 1 });
    expect(incomplete.items.filter(i => i.source === 'proposals')).toHaveLength(1);
  });

  it('reports unavailable on an empty refused read or a throwing seam while other sources list', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const refused = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readInboxProposals: () => section([], { state: 'unavailable' }),
    });
    expect(refused.sources.proposals).toEqual({ state: 'unavailable', pending: null });
    expect(refused.items.filter(i => i.source === 'proposals')).toHaveLength(0);
    expect(refused.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
    const throwing = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readInboxProposals: () => { throw new Error('boom'); },
    });
    expect(throwing.sources.proposals).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });
});

describe('readUnifiedInbox slack requests', () => {
  const journalRow = (over: Partial<SlackObservation> = {}): SlackObservation => ({
    at: new Date(now - 30 * 60_000).toISOString(),
    decision: 'ingested',
    channelId: 'C0123ABCD',
    threadTs: '1762000000.000100',
    messageTs: '1762000000.000200',
    bus: 'failed',
    ...over,
  });
  const journal = (entries: SlackObservation[], state: 'ok' | 'missing' | 'degraded' = 'ok'): SlackJournalRead => ({ state, entries });
  const pinned = {
    readRequests: () => ({ status: 'missing' as const, requests: [] }),
  };
  const readWith = (readSlackJournal: () => SlackJournalRead) =>
    readUnifiedInbox({ runsDir, busRoot, now: () => now, ...pinned, readSlackJournal });

  it('lists failed bus appends as warn items with per-request trace links; every other row stays out', async () => {
    const inbox = await readWith(() => journal([
      journalRow(),
      // A posted append has a durable envelope — the bus source owns it.
      journalRow({ bus: 'posted' }),
      // A duplicate append proves the envelope already exists.
      journalRow({ bus: 'duplicate', messageTs: '1762000000.000300' }),
      // A legacy ingested row carries no bus outcome — ingress unknown, never proven pending here.
      journalRow({ bus: undefined, messageTs: '1762000000.000400' }),
      // Ignored events never reached the bus append path at all.
      journalRow({ decision: 'ignored', reason: 'foreign-team', messageTs: '1762000000.000500' }),
      // An ingested row missing the ids the trace requires emits no row.
      journalRow({ channelId: undefined, messageTs: '1762000000.000600' }),
    ]));
    expect(inbox.sources.slack).toEqual({ state: 'healthy', pending: 1 });
    const items = inbox.items.filter(i => i.source === 'slack');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'slack:C0123ABCD:1762000000.000200',
      kind: 'slack-request', severity: 'warn', blocking: false,
      title: 'Slack request failed bus ingress',
      detail: 'channel C0123ABCD · thread 1762000000.000100 · message 1762000000.000200 · waiting 30m',
      since: new Date(now - 30 * 60_000).toISOString(), expiresAt: null,
      act: [
        'phm fleet slack-trace --channel C0123ABCD --thread 1762000000.000100 --message 1762000000.000200 --json',
        'phm channels slack status --json',
      ],
    });
    // Journal rows carry author/request ids and never message text; the item
    // must not either.
    expect(JSON.stringify(items[0])).not.toContain('authorId');
    expect(JSON.stringify(items[0])).not.toContain('requestId');
  });

  it('collapses repeated failed ingests of the same message to the newest row', async () => {
    const inbox = await readWith(() => journal([
      journalRow({ at: new Date(now - 90 * 60_000).toISOString() }),
      journalRow({ at: new Date(now - 10 * 60_000).toISOString() }),
      journalRow({ messageTs: '1762000000.000900', threadTs: '1762000000.000800' }),
    ]));
    const items = inbox.items.filter(i => i.source === 'slack');
    expect(items.map(i => i.id).sort()).toEqual([
      'slack:C0123ABCD:1762000000.000200',
      'slack:C0123ABCD:1762000000.000900',
    ]);
    expect(items.find(i => i.id === 'slack:C0123ABCD:1762000000.000200')).toMatchObject({
      since: new Date(now - 10 * 60_000).toISOString(),
      detail: 'channel C0123ABCD · thread 1762000000.000100 · message 1762000000.000200 · waiting 10m',
    });
  });

  it('keeps only the bare trace links when row ids fail the shape guard', async () => {
    const inbox = await readWith(() => journal([
      journalRow({ channelId: 'bad id; touch /tmp/x', threadTs: 'also bad', messageTs: 'worse; rm -rf /' }),
    ]));
    const item = inbox.items.find(i => i.source === 'slack')!;
    expect(item.act).toEqual(['phm fleet slack-trace --json', 'phm channels slack status --json']);
  });

  it('reports the journal state as the source state, never a fabricated healthy', async () => {
    const missing = await readWith(() => journal([], 'missing'));
    expect(missing.sources.slack).toEqual({ state: 'missing', pending: 0 });
    const degraded = await readWith(() => journal([journalRow()], 'degraded'));
    expect(degraded.sources.slack).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'slack')).toHaveLength(1);
  });

  it('reports unavailable on a throwing seam while other sources still list', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readSlackJournal: () => { throw new Error('boom'); },
    });
    expect(inbox.sources.slack).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'slack')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });
});

describe('readUnifiedInbox peer dispatch', () => {
  const queueId = (c: string) => `peer-work-${c.repeat(32)}`;
  const receiptId = (c: string) => `pw-${c.repeat(32)}`;
  const receipt = (over: Record<string, unknown> = {}) => ({
    kind: 'work.result', jobId: 'RQ-PEER-1', claimKey: `queue:${queueId('a')}`,
    queueId: queueId('a'), receiptId: receiptId('b'), outcome: 'admitted',
    peer: 'peer-a', consumer: 'dispatch', digest: 'c'.repeat(64),
    at: now - 3_600_000, ...over,
  });
  /** The journal `consumePeerWork` writes under `<busRoot>/agentnet/` — the default reader's real path. */
  const writeJournal = (receipts: unknown[]) => {
    const dir = join(busRoot, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'work-dispatch.json'), JSON.stringify({ version: 1, receipts }), { mode: 0o600 });
  };

  it('lists receipts whose latest outcome was never confirmed sent, and keeps sent ones out', async () => {
    writeJournal([
      // sent trails outcome — the peer still waits on the newer result.
      receipt({ sent: 'reserved' }),
      // sent absent entirely — never published.
      receipt({ outcome: 'complete', queueId: queueId('d'), receiptId: receiptId('e'), claimKey: `queue:${queueId('d')}` }),
      // Latest outcome already published — history, not pending.
      receipt({ outcome: 'failed', reason: 'repo-denied', sent: 'failed', queueId: queueId('f'), receiptId: receiptId('0'), claimKey: `queue:${queueId('f')}` }),
      // Outcome and sent agree — nothing owed.
      receipt({ outcome: 'reserved', sent: 'reserved', queueId: queueId('1'), receiptId: receiptId('2'), claimKey: `queue:${queueId('1')}` }),
    ]);
    const inbox = await read();
    expect(inbox.sources['peer-dispatch']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'peer-dispatch');
    expect(items).toHaveLength(2);
    const byId = new Map(items.map(i => [i.id, i]));
    expect(byId.get(`peer-dispatch:${receiptId('b')}`)).toMatchObject({
      kind: 'peer-dispatch-result',
      severity: 'warn', blocking: false,
      title: 'peer peer-a awaits admitted result for RQ-PEER-1',
      detail: `consumer dispatch · queue ${queueId('a')} · receipt ${receiptId('b')} · last sent reserved`,
      since: null, expiresAt: null, jobIds: ['RQ-PEER-1'],
      act: ['phm agentnet peers dispatch --apply'],
    });
    expect(byId.get(`peer-dispatch:${receiptId('e')}`)).toMatchObject({
      title: 'peer peer-a awaits complete result for RQ-PEER-1',
      detail: `consumer dispatch · queue ${queueId('d')} · receipt ${receiptId('e')} · last sent none`,
    });
    // Journal fields are callsigns, ids and outcome codes — never message text.
    expect(JSON.stringify(items)).not.toContain('fake work');
  });

  it('keeps one item per receipt id even if a hand-edited journal repeats one', async () => {
    writeJournal([receipt({ sent: 'reserved' }), receipt({ sent: 'reserved' })]);
    const inbox = await read();
    expect(inbox.sources['peer-dispatch']).toEqual({ state: 'healthy', pending: 1 });
    expect(inbox.items.filter(i => i.source === 'peer-dispatch')).toHaveLength(1);
  });

  it('reports the journal state honestly: missing, unreadable, throwing seam', async () => {
    const missing = await read();
    expect(missing.sources['peer-dispatch']).toEqual({ state: 'missing', pending: 0 });

    const dir = join(busRoot, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'work-dispatch.json'), '{not json', { mode: 0o600 });
    const degraded = await read();
    expect(degraded.sources['peer-dispatch']).toEqual({ state: 'unavailable', pending: null });
    expect(degraded.items.filter(i => i.source === 'peer-dispatch')).toHaveLength(0);

    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    rmSync(join(dir, 'work-dispatch.json'));
    const throwing = await read({
      readPeerDispatch: () => { throw new Error('boom'); },
    });
    expect(throwing.sources['peer-dispatch']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('filters by source, kind, job citation and contains like every other source', async () => {
    writeJournal([
      receipt({ sent: 'reserved' }),
      receipt({ jobId: 'RQ-OTHER', sent: 'reserved', queueId: queueId('3'), receiptId: receiptId('4'), claimKey: `queue:${queueId('3')}` }),
    ]);
    const inbox = await read({ filter: { source: 'peer-dispatch' } });
    expect(inbox.total).toBe(2);
    expect(inbox.items.every(i => i.source === 'peer-dispatch' && i.kind === 'peer-dispatch-result')).toBe(true);
    expect(inbox.sources['peer-dispatch']).toEqual({ state: 'healthy', pending: 2 });

    const byJob = await read({ filter: { job: 'RQ-PEER-1' } });
    expect(byJob.items.map(i => i.id)).toEqual([`peer-dispatch:${receiptId('b')}`]);
    expect(byJob.items[0]!.jobIds).toEqual(['RQ-PEER-1']);

    const byKind = await read({ filter: { kind: 'peer-dispatch-result', source: 'peer-dispatch' } });
    expect(byKind.total).toBe(2);
    const byText = await read({ filter: { contains: 'awaits complete' } });
    expect(byText.items).toEqual([]);
    const byPeer = await read({ filter: { contains: 'peer peer-a' } });
    expect(byPeer.items.map(i => i.id).sort()).toEqual([`peer-dispatch:${receiptId('4')}`, `peer-dispatch:${receiptId('b')}`].sort());
  });
});

describe('readUnifiedInbox teammate tasks', () => {
  const ledgerDir = () => join(runsDir, 'imessage');
  let taskSeq = 0;
  /** A schema-valid stored task row; `over` replaces fields (undefined drops the key). */
  const task = (over: Record<string, unknown> = {}) => {
    taskSeq += 1;
    return {
      jobId: `RQ-TT-${taskSeq}`, peer: 'dot', kind: 'research', scope: 'fake scope',
      repo: 'ashlrai/phantom', prRefs: [], format: 'fake format',
      deadline: new Date(now + 3_600_000).toISOString(),
      token: taskSeq.toString(16).padStart(32, '0'),
      createdAt: now - 600_000, state: 'pending', attemptedAt: now - 300_000,
      receipt: { rowid: 1000 + taskSeq * 10, sent: true, delivered: true, error: 0 },
      metrics: ['launch'], settled: false, ...over,
    };
  };
  const writeLedger = (tasks: unknown[]) => {
    mkdirSync(ledgerDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(ledgerDir(), 'teammate-tasks.json'),
      JSON.stringify({ v: 1, tasks, attempts: { dot: [], instinct: [] } }), { mode: 0o600 });
  };
  const pinned = {
    readRequests: () => ({ status: 'missing' as const, requests: [] }),
    readInboxProposals: () => ({ state: 'ok' as const, items: [], truncated: false }),
    readTeamApprovals: (): Section<TeamApprovalItem> => ({ state: 'ok', items: [] }),
  };

  it('lists unsettled tasks by state with honest severity, times and acts', async () => {
    writeLedger([
      task({ jobId: 'RQ-TT-QUEUED', state: 'queued', attemptedAt: undefined, receipt: undefined }),
      task({ jobId: 'RQ-TT-SENDING', state: 'sending', receipt: undefined }),
      task({ jobId: 'RQ-TT-PENDING' }),
      task({ jobId: 'RQ-TT-OVERDUE', deadline: new Date(now - 3_600_000).toISOString() }),
      task({ jobId: 'RQ-TT-REPLIED', state: 'replied',
        result: { rowid: 7777, status: 'DONE', summary: 'fake peer summary', at: now - 60_000 } }),
      task({ jobId: 'RQ-TT-EXPIRED', state: 'expired', deadline: new Date(now - 60_000).toISOString() }),
      task({ jobId: 'RQ-TT-DONE', state: 'replied', settled: true,
        result: { rowid: 7778, status: 'DONE', summary: 'fake peer summary', at: now - 120_000 } }),
      task({ jobId: 'RQ-TT-CANCEL', state: 'cancelled', attemptedAt: undefined, receipt: undefined, metrics: [] }),
    ]);
    const inbox = await read();
    expect(inbox.sources['teammate-tasks']).toEqual({ state: 'healthy', pending: 6 });
    const items = inbox.items.filter(i => i.source === 'teammate-tasks');
    expect(items.map(i => i.id).sort()).toEqual([
      'teammate-tasks:RQ-TT-EXPIRED', 'teammate-tasks:RQ-TT-OVERDUE', 'teammate-tasks:RQ-TT-PENDING',
      'teammate-tasks:RQ-TT-QUEUED', 'teammate-tasks:RQ-TT-REPLIED', 'teammate-tasks:RQ-TT-SENDING',
    ].sort());
    const byId = (id: string) => items.find(i => i.id === `teammate-tasks:${id}`)!;
    const acts = (id: string) => ['phm fleet imessage-tasks dispatch --apply', `phm fleet imessage-tasks list --job ${id}`];
    expect(byId('RQ-TT-QUEUED')).toMatchObject({
      kind: 'teammate-task', severity: 'info', blocking: false,
      title: 'teammate dot research RQ-TT-QUEUED',
      detail: 'ashlrai/phantom · reserved, awaiting dispatch · due in 1h 0m',
      since: '2026-11-07T11:50:00.000Z', expiresAt: '2026-11-07T13:00:00.000Z', act: acts('RQ-TT-QUEUED'),
    });
    expect(byId('RQ-TT-SENDING')).toMatchObject({
      severity: 'warn', detail: 'ashlrai/phantom · send in flight, awaiting reconcile · due in 1h 0m',
      since: '2026-11-07T11:55:00.000Z', expiresAt: '2026-11-07T13:00:00.000Z',
    });
    expect(byId('RQ-TT-PENDING')).toMatchObject({
      severity: 'info', detail: 'ashlrai/phantom · awaiting peer result · due in 1h 0m',
      since: '2026-11-07T11:55:00.000Z', expiresAt: '2026-11-07T13:00:00.000Z',
    });
    expect(byId('RQ-TT-OVERDUE')).toMatchObject({
      severity: 'warn', detail: 'ashlrai/phantom · awaiting peer result · overdue 1h 0m',
      expiresAt: '2026-11-07T11:00:00.000Z',
    });
    expect(byId('RQ-TT-REPLIED')).toMatchObject({
      severity: 'warn',
      detail: 'ashlrai/phantom · peer reported DONE, settle owed · peer-reported, unverified',
      since: '2026-11-07T11:59:00.000Z', expiresAt: null,
    });
    expect(byId('RQ-TT-EXPIRED')).toMatchObject({
      severity: 'warn', detail: 'ashlrai/phantom · deadline elapsed, settle owed',
      since: '2026-11-07T11:59:00.000Z', expiresAt: null,
    });
    // Scope, format, RESULT text and the correlation token never reach an item.
    const serialized = JSON.stringify(items);
    for (const secret of ['fake scope', 'fake format', 'fake peer summary']) expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/[a-f0-9]{32}/);
  });

  it('reports missing, verified-empty and unreadable ledgers honestly', async () => {
    expect((await read()).sources['teammate-tasks']).toEqual({ state: 'missing', pending: 0 });
    writeLedger([]);
    expect((await read()).sources['teammate-tasks']).toEqual({ state: 'healthy', pending: 0 });
    writeFileSync(join(ledgerDir(), 'teammate-tasks.json'), '{oops', { mode: 0o600 });
    const broken = await read();
    expect(broken.sources['teammate-tasks']).toEqual({ state: 'unavailable', pending: null });
    expect(broken.items.filter(i => i.source === 'teammate-tasks')).toHaveLength(0);
    writeLedger([{ jobId: 'bad' }]);
    expect((await read()).sources['teammate-tasks']).toEqual({ state: 'unavailable', pending: null });
  });

  it('keeps a replied task RESULT text under the task item, not the texts source', async () => {
    writeLedger([task({ jobId: 'RQ-TT-REPLY', state: 'replied',
      result: { rowid: 7777, status: 'DONE', summary: 'fake peer summary', at: now - 60_000 } })]);
    expect(recordTeammateText({ rowid: 7777, handle: '+1555fake', text: 'RESULT RQ-TT-REPLY deadbeef DONE fake' }, runsDir, new Date(now - 60_000))).toBe(true);
    expect(recordTeammateText({ rowid: 8888, handle: '+1555fake', text: 'unrelated teammate note' }, runsDir, new Date(now - 30_000))).toBe(true);
    const inbox = await read();
    // One pending thing, one item: the covered RESULT rowid does not list twice.
    expect(inbox.items.filter(i => i.source === 'imessage').map(i => i.id)).toEqual(['imessage:teammate-8888']);
    expect(inbox.items.filter(i => i.source === 'teammate-tasks').map(i => i.id)).toEqual(['teammate-tasks:RQ-TT-REPLY']);
    expect(inbox.sources['imessage']).toEqual({ state: 'healthy', pending: 1 });
    expect(inbox.sources['teammate-tasks']).toEqual({ state: 'healthy', pending: 1 });
  });

  it('builds items from an injected read and reports seam states while other sources list', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const throwing = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readTeammateTasks: () => { throw new Error('boom'); },
    });
    expect(throwing.sources['teammate-tasks']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
    const degraded = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readTeammateTasks: () => ({ state: 'degraded', tasks: [] }),
    });
    expect(degraded.sources['teammate-tasks']).toEqual({ state: 'degraded', pending: 0 });
    expect(degraded.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });
});

describe('legacy phm bus mailbox in the unified inbox', () => {
  // The mailbox store lives at <dirname(busRoot)>/bus-mailbox — `root` here —
  // the same home `agents bus status` and `work mine` derive from the fleet root.
  const mailbox = () => createBusMailbox(root, () => now);
  const send = (envelope: BusEnvelope) => {
    const result = mailbox().send(envelope);
    expect(result.replayed).toBe(false);
    return result.id;
  };

  it('lists pending mail across every recipient label in drain order with per-label acts', async () => {
    send({ id: 'mb-low', from: 'codex-cmp', to: 'other', priority: 'P3', ttl: 60_000, body: { kind: 'work', text: 'fake low mail' } });
    send({ id: 'mb-first', from: 'codex-cmp', to: 'fleet', priority: 'P0', ttl: 60_000, body: { kind: 'work', text: 'fake first mail' } });
    send({ id: 'mb-second', from: 'codex-cmp', to: 'other', priority: 'P0', ttl: 60_000, body: { kind: 'work', text: 'fake second mail' } });
    send({ id: 'mb-mid', from: 'codex-cmp', to: 'fleet', priority: 'P1', ttl: 60_000, body: { kind: 'work', text: 'fake mid mail' } });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'mailbox');
    expect(items.map(i => i.id)).toEqual(['mailbox:mb-first', 'mailbox:mb-second', 'mailbox:mb-mid', 'mailbox:mb-low']);
    expect(items[0]).toMatchObject({
      kind: 'mailbox-message', severity: 'high', blocking: false,
      title: 'work: fake first mail',
      detail: 'from codex-cmp to fleet · P0',
      since: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      act: ['phm bus inbox --to fleet', 'phm bus ack mb-first --to fleet'],
    });
    expect(items[1]).toMatchObject({
      severity: 'high', detail: 'from codex-cmp to other · P0',
      act: ['phm bus inbox --to other', 'phm bus ack mb-second --to other'],
    });
    expect(items[2]).toMatchObject({ severity: 'warn', detail: 'from codex-cmp to fleet · P1' });
    expect(items[3]).toMatchObject({ severity: 'info', detail: 'from codex-cmp to other · P3' });
    expect(inbox.sources.mailbox).toEqual({ state: 'healthy', pending: 4 });
  });

  it('omits acknowledged and expired mail and reports a missing store honestly', async () => {
    expect((await read()).sources.mailbox).toEqual({ state: 'missing', pending: 0 });
    const mb = mailbox();
    mb.send({ id: 'mb-stale', from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 1_000, body: 'fake stale mail' });
    mb.send({ id: 'mb-acked', from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 60_000, body: 'fake acked mail' });
    mb.send({ id: 'mb-live', from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 60_000, body: 'fake live mail' });
    mb.ack('mb-acked', 'fleet');
    now += 2_000; // mb-stale's 1s TTL elapsed; mb-live still has 58s left.
    const inbox = await read();
    expect(inbox.sources.mailbox).toEqual({ state: 'healthy', pending: 1 });
    const items = inbox.items.filter(i => i.source === 'mailbox');
    expect(items.map(i => i.id)).toEqual(['mailbox:mb-live']);
    expect(items[0]).toMatchObject({
      title: 'fake live mail',
      since: new Date(now - 2_000).toISOString(),
      expiresAt: new Date(now - 2_000 + 60_000).toISOString(),
    });
  });

  it('reports missing, unavailable, throwing and truncated reads honestly while other sources list', async () => {
    postWork('mailbox-neighbor');
    const opts = { runsDir, busRoot, now: () => now, readRequests: () => ({ status: 'missing' as const, requests: [] }) };
    const message = (id: string): BusMailboxPendingMessage => ({
      envelope: { id, from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 60_000, body: 'fake mail' },
      acceptedAt: now,
    });
    const readWith = (readMailbox: NonNullable<UnifiedInboxOptions['readMailbox']>) =>
      readUnifiedInbox({ ...opts, readMailbox });
    const missing = await readWith(() => ({ source: 'missing', messages: [], matched: 0 }));
    expect(missing.sources.mailbox).toEqual({ state: 'missing', pending: 0 });
    const unavailable = await readWith(() => ({ source: 'unavailable', messages: [], matched: null }));
    expect(unavailable.sources.mailbox).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:mailbox-neighbor']);
    const throwing = await readWith(() => { throw new Error('boom'); });
    expect(throwing.sources.mailbox).toEqual({ state: 'unavailable', pending: null });
    const truncated = await readWith(() => ({ source: 'available', messages: [message('mb-1')], matched: 7 }));
    expect(truncated.sources.mailbox).toEqual({ state: 'degraded', pending: 1 });
    expect(truncated.items.filter(i => i.source === 'mailbox').map(i => i.id)).toEqual(['mailbox:mb-1']);
  });

  it('scrubs secret-shaped mail bodies before they reach the item', async () => {
    // The store itself refuses credential-shaped envelopes, so this exercises
    // the projection's own scrub through the seam — defense in depth.
    const message = (body: string): BusMailboxPendingMessage => ({
      envelope: { id: 'mb-secret', from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 60_000, body: { kind: 'note', text: body } },
      acceptedAt: now,
    });
    const inbox = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing' as const, requests: [] }),
      readMailbox: () => ({ source: 'available', messages: [message('token sk-abcdefghijklmnop leaked')], matched: 1 }) });
    const item = inbox.items.find(i => i.id === 'mailbox:mb-secret')!;
    expect(item.title).toBe('token [REDACTED] leaked');
    expect(item.title).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('shared task board in the unified inbox', () => {
  // busBoardStoragePaths(busRoot) derives boardRoot = <dirname(busRoot)>/bus
  // — busRoot itself in this fixture — and queueRoot = busRoot/bus-queue:
  // the same scratch stores the default board read probes.
  const board = () => new BusBoard({
    root: busRoot,
    fleet: new SharedStore(join(busRoot, 'bus-queue'), 60_000),
    cfg: { foundry: {} } as AshlrConfig,
  });
  const digest = (over: Partial<BusBoardPendingPeers> = {}): BusBoardPendingPeers => ({
    peers: ['alice'], claims: 'readable', threads: [],
    deliveries: { matched: 0, items: [], truncated: false },
    tasks: { matched: 0, items: [], truncated: false },
    ...over,
  });
  const fakeDelivery = (id: string, text = 'fake board post'): BusBoardDelivery => ({
    schemaVersion: 1, id, threadId: 'thread-1', sender: 'alice', recipient: 'bob',
    createdAt: new Date(now).toISOString(),
    message: { id, from: 'alice', to: 'bob', priority: 'P2', ttl: 60_000 },
    content: { trust: 'untrusted', text: JSON.stringify({ body: { text } }) },
  });
  const fakeTask = (id: string, hold: BusBoardTaskHold, over: Partial<BusBoardPendingTask> = {}): BusBoardPendingTask => ({
    id, threadId: 'thread-1', itemId: `fleet-${id}`,
    content: { trust: 'untrusted', text: 'Fake task title' },
    claimed: false, hold, owner: null, ...over,
  });
  const readWith = (readBoard: NonNullable<UnifiedInboxOptions['readBoard']>) =>
    readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing' as const, requests: [] }), readBoard });

  it('reports a never-used board as missing, honestly empty', async () => {
    expect((await read()).sources.board).toEqual({ state: 'missing', pending: 0 });
  });

  it('lists unacknowledged deliveries and unheld tasks across every peer while held work stays out', async () => {
    const store = board();
    const threadId = store.createThread('alice', 'Rollout').id;
    store.joinThread('bob', threadId);
    const posted = await store.post('alice', threadId, 'fake board post');
    expect(posted.delivered).toBe(2); // one delivery per member, sender included
    const open = store.createTask('alice', threadId, 'item-open', 'Fake open task');
    const held = store.createTask('alice', threadId, 'item-held', 'Fake held task');
    store.claimTask('alice', held.id);
    const pending = store.pendingAll(now);
    expect(pending.deliveries.matched).toBe(2);
    expect(pending.tasks.items.map(t => t.hold).sort()).toEqual(['held', 'open']);

    const inbox = await read();
    expect(inbox.sources.board).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'board');
    const deliveries = items.filter(i => i.kind === 'board-delivery');
    const tasks = items.filter(i => i.kind === 'board-task');
    expect(deliveries).toHaveLength(2);
    expect(tasks.map(i => i.id)).toEqual([`board:task:${open.id}`]);
    const toBob = deliveries.find(i => i.detail?.includes('→ bob'))!;
    const bobDelivery = pending.deliveries.items.find(d => d.recipient === 'bob')!;
    expect(toBob).toMatchObject({
      severity: 'info', blocking: false,
      title: 'fake board post',
      detail: `thread ${threadId} · alice → bob · awaiting receipt`,
      expiresAt: null,
      act: [
        `phm bus thread pending ${threadId} --peer bob`,
        `phm bus thread ack ${threadId} ${bobDelivery.id} --peer bob`,
      ],
    });
    expect(toBob.since).toBe(bobDelivery.createdAt);
    expect(tasks[0]).toMatchObject({
      severity: 'info', blocking: false,
      title: 'Fake open task',
      detail: `thread ${threadId} · fleet item item-open · unclaimed`,
      since: null, expiresAt: null,
      act: [
        `phm bus task claim ${open.id} --peer <label>`,
        `phm bus task list ${threadId} --peer <label>`,
      ],
    });
    // The held task is in flight, not pending — it never lists.
    expect(items.some(i => i.id === `board:task:${held.id}`)).toBe(false);
    // Reading acknowledged nothing.
    expect(store.pendingAll(now).deliveries.matched).toBe(2);
  });

  it('acknowledging a delivery removes only its row; an ambiguous or unknown hold still lists as warn', async () => {
    const store = board();
    const threadId = store.createThread('alice', 'Rollout').id;
    store.joinThread('bob', threadId);
    await store.post('alice', threadId, 'fake board post');
    const snapshot = store.pendingAll(now);
    store.acknowledge('bob', threadId, snapshot.deliveries.items.find(d => d.recipient === 'bob')!.id);

    const inbox = await readWith(() => ({ source: 'available', pending: digest({
      deliveries: { matched: 1, items: [fakeDelivery('d-1')], truncated: false },
      tasks: { matched: 2, items: [fakeTask('t-open', 'open'), fakeTask('t-amb', 'ambiguous', { claimed: true })], truncated: false },
    }) }));
    // The real read: bob's copy is acknowledged, alice's still lists.
    const real = await read();
    expect(real.sources.board).toEqual({ state: 'healthy', pending: 1 });
    expect(real.items.filter(i => i.source === 'board').map(i => i.kind)).toEqual(['board-delivery']);
    // The seam read: both unheld hold classes list; ambiguous warns.
    const seamItems = inbox.items.filter(i => i.source === 'board');
    expect(seamItems.map(i => i.id).sort()).toEqual(['board:delivery:d-1', 'board:task:t-amb', 'board:task:t-open']);
    expect(seamItems.find(i => i.id === 'board:task:t-open')).toMatchObject({ severity: 'info' });
    expect(seamItems.find(i => i.id === 'board:task:t-amb')).toMatchObject({
      severity: 'warn',
      detail: 'thread thread-1 · fleet item fleet-t-amb · ambiguous hold — expired claim the claim path never reclaims · claim record on file',
      act: ['phm bus task list thread-1 --peer <label>', 'phm bus board pending --peer <label>'],
    });
    expect(inbox.sources.board).toEqual({ state: 'healthy', pending: 3 });
  });

  it('reports unavailable for a malformed board and degraded for unreadable claims or truncated lists', async () => {
    postWork('board-neighbor');
    writeFileSync(join(busRoot, 'state.json'), 'not json', { mode: 0o600 });
    const broken = await read();
    expect(broken.sources.board).toEqual({ state: 'unavailable', pending: null });
    expect(broken.items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:board-neighbor']);

    const opts = { runsDir, busRoot, now: () => now, readRequests: () => ({ status: 'missing' as const, requests: [] }) };
    const unavailable = await readUnifiedInbox({ ...opts, readBoard: () => ({ source: 'unavailable' }) });
    expect(unavailable.sources.board).toEqual({ state: 'unavailable', pending: null });
    const throwing = await readUnifiedInbox({ ...opts, readBoard: () => { throw new Error('boom'); } });
    expect(throwing.sources.board).toEqual({ state: 'unavailable', pending: null });
    const missing = await readUnifiedInbox({ ...opts, readBoard: () => ({ source: 'missing' }) });
    expect(missing.sources.board).toEqual({ state: 'missing', pending: 0 });
    const unreadableClaims = await readUnifiedInbox({ ...opts, readBoard: () => ({ source: 'available', pending: digest({
      claims: 'unreadable',
      tasks: { matched: 1, items: [fakeTask('t-1', 'unknown')], truncated: false },
    }) }) });
    expect(unreadableClaims.sources.board).toEqual({ state: 'degraded', pending: 1 });
    expect(unreadableClaims.items.find(i => i.id === 'board:task:t-1')).toMatchObject({
      severity: 'warn', detail: 'thread thread-1 · fleet item fleet-t-1 · hold unknown — shared queue unreadable',
    });
    for (const truncated of [
      digest({ deliveries: { matched: 60, items: [fakeDelivery('d-1')], truncated: true } }),
      digest({ tasks: { matched: 60, items: [fakeTask('t-1', 'open')], truncated: true } }),
    ]) {
      const result = await readUnifiedInbox({ ...opts, readBoard: () => ({ source: 'available', pending: truncated }) });
      expect(result.sources.board.state).toBe('degraded');
    }
  });

  it('falls back to a generic act on stored ids outside the identifier grammar and scrubs untrusted text', async () => {
    const inbox = await readWith(() => ({ source: 'available', pending: digest({
      deliveries: { matched: 1, items: [fakeDelivery('d-bad;rm -rf', 'token sk-abcdefghijklmnop leaked')], truncated: false },
      tasks: { matched: 1, items: [fakeTask('t-bad id', 'open', { content: { trust: 'untrusted' as const, text: 'sk-abcdefghijklmnop task' } })], truncated: false },
    }) }));
    const delivery = inbox.items.find(i => i.id === 'board:delivery:d-bad;rm -rf')!;
    expect(delivery.title).toBe('token [REDACTED] leaked');
    expect(delivery.act).toEqual(['phm bus board pending --peer <label>']);
    const task = inbox.items.find(i => i.id === 'board:task:t-bad id')!;
    expect(task.title).toBe('[REDACTED] task');
    expect(task.act).toEqual(['phm bus board pending --peer <label>']);
  });
});

describe('readUnifiedInbox ordering and bounds', () => {
  it('orders severity band first, then priority, then expiry', async () => {
    // info band: a teammate text (this-week) and a P2 work item expiring in 2 days.
    recordTeammateText({ rowid: 50, handle: '+1555fake', text: 'status?' }, runsDir, new Date(now - 60_000));
    postWork('slow-p2', { priority: 'P2', ttl: 48 * 3_600_000 });
    // warn band: needs-you (hard limit, blocking → now) and P1 work (warn → today).
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- Rotate the deploy secret for the example app\n');
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

describe('readUnifiedInbox view filters', () => {
  it('narrows items by source while per-source reports stay unfiltered', async () => {
    postWork('flt-bus');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const all = await read();
    expect(all.total).toBe(2);
    expect(all.filter).toBeUndefined();

    const busOnly = await read({ filter: { source: 'bus' } });
    expect(busOnly.filter).toEqual({ source: 'bus' });
    expect(busOnly.total).toBe(1);
    expect(busOnly.items.map(i => i.id)).toEqual(['bus:flt-bus']);
    // The source report is the unfiltered store truth: needs-you still has
    // its pending item even though the narrowed view shows none of them.
    expect(busOnly.sources['needs-you'].pending).toBe(1);
    expect(busOnly.sources.bus.pending).toBe(1);

    const none = await read({ filter: { source: 'gmail' } });
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
    expect(none.omitted).toBe(0);
    expect(none.sources.bus.pending).toBe(1);
    expect(none.sources['needs-you'].pending).toBe(1);
  });

  it('ANDs severity and blocking dimensions over stored item fields', async () => {
    postWork('flt-p0', { priority: 'P0' });   // bus: high, non-blocking
    postWork('flt-p1', { priority: 'P1' });   // bus: warn, non-blocking
    postWork('flt-p2');                        // bus: info, non-blocking
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- Rotate the deploy secret for the example app\n');  // needs-you: warn, blocking (hard limit)
    recordTeammateText({ rowid: 77, handle: '+1555fake', text: 'status?' }, runsDir, new Date(now - 60_000));  // imessage: info, non-blocking

    const high = await read({ filter: { severity: 'high' } });
    expect(high.total).toBe(1);
    expect(high.items.map(i => i.id)).toEqual(['bus:flt-p0']);

    const warn = await read({ filter: { severity: 'warn' } });
    expect(warn.total).toBe(2);
    expect(warn.items.map(i => i.source).sort()).toEqual(['bus', 'needs-you']);
    expect(warn.items.find(i => i.source === 'bus')!.id).toBe('bus:flt-p1');
    expect(warn.items.every(i => i.severity === 'warn')).toBe(true);

    const blocking = await read({ filter: { blocking: true } });
    expect(blocking.total).toBe(1);
    expect(blocking.items[0]!.source).toBe('needs-you');

    const nonBlockingBus = await read({ filter: { source: 'bus', blocking: false } });
    expect(nonBlockingBus.total).toBe(3);
    expect(nonBlockingBus.items.every(i => i.source === 'bus' && !i.blocking)).toBe(true);

    const warnBus = await read({ filter: { source: 'bus', severity: 'warn' } });
    expect(warnBus.total).toBe(1);
    expect(warnBus.items[0]!.id).toBe('bus:flt-p1');
  });

  it('counts total and omitted over the matched set and treats an empty filter as unfiltered', async () => {
    postWorkSnapshot(Array.from({ length: UNIFIED_INBOX_MAX_ITEMS + 5 }, (_, i) => `flt-${i}`));
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const busOnly = await read({ filter: { source: 'bus' } });
    expect(busOnly.total).toBe(UNIFIED_INBOX_MAX_ITEMS + 5);
    expect(busOnly.items).toHaveLength(UNIFIED_INBOX_MAX_ITEMS);
    expect(busOnly.omitted).toBe(5);
    const needsOnly = await read({ filter: { source: 'needs-you' } });
    expect(needsOnly.total).toBe(1);
    expect(needsOnly.omitted).toBe(0);

    const empty = await read({ filter: {} });
    expect(empty.filter).toBeUndefined();
    expect(empty.total).toBe(UNIFIED_INBOX_MAX_ITEMS + 6);
  });
});

describe('readUnifiedInbox kind filter', () => {
  // The same board store the board describe derives: boardRoot = busRoot here.
  const boardStore = () => new BusBoard({
    root: busRoot,
    fleet: new SharedStore(join(busRoot, 'bus-queue'), 60_000),
    cfg: { foundry: {} } as AshlrConfig,
  });
  const seedKinds = async () => {
    postWork('kind-work');                                                        // bus / bus-work
    const handoffId = postV2Body({ kind: 'worker-handoff', taskId: 'RQ-KIND-H', prompt: 'fake handoff' },
      { to: 'agent:worker-9' });                                                  // bus / bus-handoff
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');    // needs-you / needs-you
    const store = boardStore();
    const threadId = store.createThread('alice', 'Rollout').id;
    store.joinThread('bob', threadId);
    await store.post('alice', threadId, 'fake board post');                       // board / board-delivery x2
    store.createTask('alice', threadId, 'item-kind', 'Fake kind task');           // board / board-task
    return { handoffId };
  };

  it('keeps only items of the filtered kind while source reports stay unfiltered', async () => {
    const { handoffId } = await seedKinds();
    const all = await read();
    expect(new Set(all.items.map(i => i.kind)))
      .toEqual(new Set(['bus-work', 'bus-handoff', 'needs-you', 'board-delivery', 'board-task']));

    // The bus source's own split: work and handoffs are one source but two kinds.
    const handoffs = await read({ filter: { kind: 'bus-handoff' } });
    expect(handoffs.filter).toEqual({ kind: 'bus-handoff' });
    expect(handoffs.items.map(i => i.id)).toEqual([`bus-handoff:${handoffId}`]);
    expect(handoffs.items[0]!.source).toBe('bus');
    // Per-source reports stay the unfiltered store truth.
    expect(handoffs.sources.bus.pending).toBe(2);
    expect(handoffs.sources.board.pending).toBe(3);
    expect(handoffs.sources['needs-you'].pending).toBe(1);

    const work = await read({ filter: { kind: 'bus-work' } });
    expect(work.items.map(i => i.id)).toEqual(['bus:kind-work']);

    // The board source's own split: deliveries and tasks are one source but two kinds.
    const tasks = await read({ filter: { kind: 'board-task' } });
    expect(tasks.items.map(i => i.kind)).toEqual(['board-task']);
    expect(tasks.sources.board.pending).toBe(3);
    const deliveries = await read({ filter: { kind: 'board-delivery' } });
    expect(deliveries.items).toHaveLength(2);
    expect(deliveries.items.every(i => i.kind === 'board-delivery')).toBe(true);

    // A 1:1 kind filters across sources exactly like its source does.
    const needs = await read({ filter: { kind: 'needs-you' } });
    expect(needs.items.map(i => i.kind)).toEqual(['needs-you']);
    expect(needs.sources.bus.pending).toBe(2);
  });

  it('ANDs kind with the other view dimensions', async () => {
    const { handoffId } = await seedKinds();
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- Rotate the deploy secret for the example app\n');

    // kind + agreeing source keeps the rows; disagreeing is an honest empty.
    const busHandoffs = await read({ filter: { kind: 'bus-handoff', source: 'bus' } });
    expect(busHandoffs.items.map(i => i.id)).toEqual([`bus-handoff:${handoffId}`]);
    const none = await read({ filter: { kind: 'bus-handoff', source: 'needs-you' } });
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
    expect(none.sources.bus.pending).toBe(2);

    // kind + severity: the P2 handoff is info; the P0 sibling check stays exact.
    const info = await read({ filter: { kind: 'bus-handoff', severity: 'info' } });
    expect(info.items.map(i => i.id)).toEqual([`bus-handoff:${handoffId}`]);
    const high = await read({ filter: { kind: 'bus-handoff', severity: 'high' } });
    expect(high.total).toBe(0);

    // kind + blocking: the hard-limit needs-you line is the only blocking item of its kind.
    const blockingNeeds = await read({ filter: { kind: 'needs-you', blocking: true } });
    expect(blockingNeeds.items).toHaveLength(1);
    expect(blockingNeeds.items[0]!.blocking).toBe(true);
  });
});

describe('readUnifiedInbox job filter', () => {
  const jobNote = (text: string, thread: string) =>
    postV2Body({ kind: 'note', text, thread }, { from: 'agent:asker', to: 'agent:reviewer' });
  const mailbox = () => createBusMailbox(root, () => now);
  const sendMail = (envelope: BusEnvelope) => {
    const result = mailbox().send(envelope);
    expect(result.replayed).toBe(false);
    return result.id;
  };
  // The same board digest shapes the board describe injects: deliveries and
  // tasks are plain stored rows, holds are the observed states.
  const boardDigest = (over: Partial<BusBoardPendingPeers> = {}): BusBoardPendingPeers => ({
    peers: ['alice'], claims: 'readable', threads: [],
    deliveries: { matched: 0, items: [], truncated: false },
    tasks: { matched: 0, items: [], truncated: false },
    ...over,
  });
  const boardDelivery = (id: string, threadId: string): BusBoardDelivery => ({
    schemaVersion: 1, id, threadId, sender: 'alice', recipient: 'bob',
    createdAt: new Date(now).toISOString(),
    message: { id, from: 'alice', to: 'bob', priority: 'P2', ttl: 60_000 },
    content: { trust: 'untrusted', text: JSON.stringify({ body: { text: 'fake board post' } }) },
  });
  const boardTask = (id: string, threadId: string, itemId: string, hold: BusBoardTaskHold = 'open'): BusBoardPendingTask => ({
    id, threadId, itemId,
    content: { trust: 'untrusted', text: 'Fake task title' },
    claimed: false, hold, owner: null,
  });
  // A schema-valid teammate-task ledger row; jobId is the fleet job the task reserves.
  const taskRow = (jobId: string, over: Record<string, unknown> = {}) => ({
    jobId, peer: 'dot', kind: 'research', scope: 'fake scope',
    repo: 'ashlrai/phantom', prRefs: [], format: 'fake format',
    deadline: new Date(now + 3_600_000).toISOString(),
    token: jobId.replace(/[^a-f0-9]/gi, '').padEnd(32, '0').slice(0, 32),
    createdAt: now - 600_000, state: 'pending', attemptedAt: now - 300_000,
    receipt: { rowid: 5000, sent: true, delivered: true, error: 0 },
    metrics: ['launch'], settled: false, ...over,
  });
  const writeLedger = (tasks: unknown[]) => {
    const dir = join(runsDir, 'imessage');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'teammate-tasks.json'),
      JSON.stringify({ v: 1, tasks, attempts: { dot: [], instinct: [] } }), { mode: 0o600 });
  };
  const seatHandoff = (seatId: string, kind: 'bus-claim' | 'node-job', ref: string, n = 0): SeatHandoff => ({
    schema: 'phantom-bot-handoff.v1', handoffId: `h-${seatId}-${n}`,
    seatId, work: { kind, ref }, done: 'unknown', left: 'unknown',
    branch: null, pr: null, createdAt: new Date(now).toISOString(),
  });
  const seatPlan = (seats: SeatHandoffPlanEntry[]): SeatHandoffsPlan =>
    ({ schema: 'phantom-bot-handoffs-plan.v1', apply: false, seats });
  const seatEntry = (over: Partial<SeatHandoffPlanEntry> = {}): SeatHandoffPlanEntry => ({
    seatId: 'devin-review', state: 'draining', eligible: true,
    handoffs: [seatHandoff('devin-review', 'node-job', 'RQ-JS-1'),
      seatHandoff('devin-review', 'bus-claim', 'queue:RQ-claim-1', 1)], ...over,
  });

  it('annotates each item with the job ids its own citation rule proves', async () => {
    postJob('RQ-JF-1');
    const handoffId = postV2Body({ kind: 'worker-handoff', taskId: 'RQ-JH-1', prompt: 'fake handoff' },
      { from: 'agent:lead', to: 'agent:worker-9' });
    jobNote('can you check this?', 'job:RQ-JC-1');
    // A schema-valid work.status cites its jobId on the raw body — the
    // conversation thread picks it up even with no `job:` bucket.
    postV2Body({ kind: 'work.status', jobId: 'RQ-JC-2', status: 'blocked', detail: 'waiting on creds' },
      { from: 'agent:worker', to: 'agent:lead' });
    sendMail({ id: 'mb-job-1', from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 60_000,
      body: { kind: 'note', text: 'fake mail', thread: 'job:RQ-JM-1' } });
    postWork('plain-work');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    writeLedger([taskRow('RQ-JT-1')]);
    const inbox = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      readBoard: () => ({ source: 'available', pending: boardDigest({
        deliveries: { matched: 1, items: [boardDelivery('d-1', 'thread-1')], truncated: false },
        tasks: { matched: 2, items: [boardTask('t-a', 'thread-1', 'RQ-JB-1'),
          boardTask('t-b', 'thread-2', 'RQ-JB-2')], truncated: false },
      }) }),
      readSeatHandoffs: async () => seatPlan([seatEntry()]),
    });
    const byId = (id: string) => inbox.items.find(i => i.id === id);
    expect(byId('bus-feed:RQ-JF-1')?.jobIds).toEqual(['RQ-JF-1']);
    expect(byId(`bus-handoff:${handoffId}`)?.jobIds).toEqual(['RQ-JH-1']);
    // The `job:<id>` bucket itself and a work.status body citation both land
    // on the thread's `jobs`, sorted and deduplicated.
    expect(byId('conversations:job:RQ-JC-1')?.jobIds).toEqual(['RQ-JC-1']);
    const convItems = inbox.items.filter(i => i.source === 'conversations');
    expect(convItems).toHaveLength(2);
    const statusThread = convItems.find(i => i.id !== 'conversations:job:RQ-JC-1')!;
    expect(statusThread.jobIds).toEqual(['RQ-JC-2']);
    expect(byId('mailbox:mb-job-1')?.jobIds).toEqual(['RQ-JM-1']);
    expect(byId('board:task:t-a')?.jobIds).toEqual(['RQ-JB-1']);
    expect(byId('board:task:t-b')?.jobIds).toEqual(['RQ-JB-2']);
    // A delivery carries the itemIds of the tasks on its own thread — the
    // job-carrying-thread citation `BusBoard.pendingFor` applies.
    expect(byId('board:delivery:d-1')?.jobIds).toEqual(['RQ-JB-1']);
    expect(byId('teammate-tasks:RQ-JT-1')?.jobIds).toEqual(['RQ-JT-1']);
    // A seat's node-job ref is a job id; its bus-claim ref is a claim key.
    expect(byId('seats:devin-review')?.jobIds).toEqual(['RQ-JS-1']);
    // Uncited items carry no jobIds at all — unknown stays out of a match.
    expect(byId('bus:plain-work')).not.toHaveProperty('jobIds');
    const needsYou = inbox.items.find(i => i.source === 'needs-you')!;
    expect(needsYou).not.toHaveProperty('jobIds');
  });

  it('keeps only items naming the job, exact-matches the id and ANDs with the other dimensions', async () => {
    postJob('RQ-JF-1');
    postJob('RQ-JF-2');
    postWork('plain-work');
    jobNote('status on this?', 'job:RQ-JC-1');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await read({ filter: { job: 'RQ-JF-1' } });
    expect(inbox.filter).toEqual({ job: 'RQ-JF-1' });
    expect(inbox.items.map(i => i.id)).toEqual(['bus-feed:RQ-JF-1']);
    expect(inbox.total).toBe(1);
    expect(inbox.omitted).toBe(0);
    // Per-source reports stay the unfiltered store truth.
    expect(inbox.sources.bus.pending).toBe(3);
    expect(inbox.sources['needs-you'].pending).toBe(1);
    expect(inbox.sources.conversations.pending).toBe(1);

    // The citation is exact: a prefix of a real job id matches nothing.
    const prefix = await read({ filter: { job: 'RQ-JF' } });
    expect(prefix.total).toBe(0);
    expect(prefix.items).toEqual([]);
    expect(prefix.sources.bus.pending).toBe(3);

    // job ANDs with source/severity/blocking like every other dimension.
    const convOnly = await read({ filter: { job: 'RQ-JC-1', source: 'conversations' } });
    expect(convOnly.total).toBe(1);
    expect(convOnly.items.map(i => i.id)).toEqual(['conversations:job:RQ-JC-1']);
    const wrongSource = await read({ filter: { job: 'RQ-JF-1', source: 'conversations' } });
    expect(wrongSource.total).toBe(0);
    const blocking = await read({ filter: { job: 'RQ-JF-1', blocking: true } });
    expect(blocking.total).toBe(0);
  });

  it('scopes board items the way pendingFor does: deliveries ride job-carrying threads, sibling tasks stay out', async () => {
    const pending = boardDigest({
      deliveries: { matched: 3, items: [
        boardDelivery('d-1', 'thread-1'), boardDelivery('d-2', 'thread-2'), boardDelivery('d-3', 'thread-3')], truncated: false },
      tasks: { matched: 3, items: [
        boardTask('t-a', 'thread-1', 'RQ-JB-1'),
        boardTask('t-b', 'thread-2', 'RQ-JB-2'),
        // A held task never lists but still marks its thread as the job's
        // board surface — the same thread scope pendingFor reads from state.
        boardTask('t-held', 'thread-3', 'RQ-JB-H', 'held')], truncated: false },
    });
    const inbox = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      readBoard: () => ({ source: 'available', pending }) });
    const boardItems = inbox.items.filter(i => i.source === 'board');
    expect(boardItems.find(i => i.id === 'board:task:t-a')?.jobIds).toEqual(['RQ-JB-1']);
    expect(boardItems.find(i => i.id === 'board:task:t-b')?.jobIds).toEqual(['RQ-JB-2']);
    expect(boardItems.find(i => i.id === 'board:delivery:d-1')?.jobIds).toEqual(['RQ-JB-1']);
    expect(boardItems.find(i => i.id === 'board:delivery:d-2')?.jobIds).toEqual(['RQ-JB-2']);
    expect(boardItems.find(i => i.id === 'board:delivery:d-3')?.jobIds).toEqual(['RQ-JB-H']);
    expect(boardItems.some(i => i.id === 'board:task:t-held')).toBe(false);

    const filtered = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      readBoard: () => ({ source: 'available', pending }),
      filter: { job: 'RQ-JB-1' } });
    expect(filtered.items.filter(i => i.source === 'board').map(i => i.id).sort())
      .toEqual(['board:delivery:d-1', 'board:task:t-a']);
    // The held task's thread still cites its job through the delivery.
    const heldThread = await readUnifiedInbox({ runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing', requests: [] }),
      readBoard: () => ({ source: 'available', pending }),
      filter: { job: 'RQ-JB-H' } });
    expect(heldThread.items.filter(i => i.source === 'board').map(i => i.id)).toEqual(['board:delivery:d-3']);
  });

  it('never treats a seat bus-claim ref as a job id', async () => {
    const opts = {
      runsDir, busRoot, now: () => now,
      readRequests: () => ({ status: 'missing' as const, requests: [] }),
      readSeatHandoffs: async () => seatPlan([seatEntry()]),
    };
    const nodeJob = await readUnifiedInbox({ ...opts, filter: { job: 'RQ-JS-1' } });
    expect(nodeJob.items.filter(i => i.source === 'seats').map(i => i.id)).toEqual(['seats:devin-review']);
    // The claim key names coordination scope, not a job — it matches nothing.
    for (const job of ['queue:RQ-claim-1', 'RQ-claim-1']) {
      const claimRef = await readUnifiedInbox({ ...opts, filter: { job } });
      expect(claimRef.items.filter(i => i.source === 'seats')).toEqual([]);
    }
  });
});

describe('readUnifiedInbox since filter', () => {
  it('keeps only items whose recorded since reaches the cutoff; undated items never match', async () => {
    postWork('flt-since-old', { at: now - 3_600_000 });
    postWork('flt-since-new', { at: now - 60_000 });
    postJob('RQ-SF-OLD', { at: now - 7_200_000 });
    postJob('RQ-SF-NEW');
    recordTeammateText({ rowid: 88, handle: '+1555fake', text: 'status?' }, runsDir, new Date(now - 30 * 60_000));
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    const all = await read();
    expect(all.total).toBe(6);
    expect(all.filter).toBeUndefined();

    // A now-2m cutoff keeps only the just-posted envelope and feed job.
    const recent = await read({ filter: { since: now - 120_000 } });
    expect(recent.filter).toEqual({ since: now - 120_000 });
    expect(recent.items.map(i => i.id).sort())
      .toEqual(['bus-feed:RQ-SF-NEW', 'bus:flt-since-new']);
    // Per-source reports stay the unfiltered store truth.
    expect(recent.sources.bus.pending).toBe(4);
    expect(recent.sources.imessage.pending).toBe(1);
    expect(recent.sources['needs-you'].pending).toBe(1);

    // A cutoff at or before every dated item still excludes the undated
    // needs-you line — unknown never counts as new.
    const everything = await read({ filter: { since: now - 48 * 3_600_000 } });
    expect(everything.items.map(i => i.id).sort())
      .toEqual(['bus-feed:RQ-SF-NEW', 'bus-feed:RQ-SF-OLD', 'bus:flt-since-new',
        'bus:flt-since-old', 'imessage:teammate-88']);
    expect(everything.items.some(i => i.source === 'needs-you')).toBe(false);
    expect(everything.total).toBe(5);
  });

  it('matches inclusively at the cutoff and ANDs with the other dimensions', async () => {
    postWork('flt-b1', { at: now - 60_000 });
    postWork('flt-b2', { at: now - 120_000 });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    // receivedAt == cutoff still matches — the same >= rule comms bus read applies.
    const exact = await read({ filter: { since: now - 60_000 } });
    expect(exact.items.map(i => i.id)).toEqual(['bus:flt-b1']);

    // since ANDs with source/severity/blocking/job like every other dimension.
    const undated = await read({ filter: { since: now - 3_600_000, source: 'needs-you' } });
    expect(undated.total).toBe(0);
    expect(undated.items).toEqual([]);
    const datedBus = await read({ filter: { since: now - 3_600_000, source: 'bus' } });
    expect(datedBus.items.map(i => i.id).sort()).toEqual(['bus:flt-b1', 'bus:flt-b2']);
    const blocking = await read({ filter: { since: now - 3_600_000, blocking: true } });
    expect(blocking.total).toBe(0);

    // A future cutoff matches nothing dated; undated items still stay out.
    const future = await read({ filter: { since: now + 60_000 } });
    expect(future.total).toBe(0);
    expect(future.items).toEqual([]);
  });
});

describe('readUnifiedInbox before filter', () => {
  it('keeps only items whose recorded since is strictly before the cutoff; undated items never match', async () => {
    postWork('flt-before-oldest', { at: now - 4 * 3_600_000 });
    postWork('flt-before-edge', { at: now - 2 * 3_600_000 });
    postWork('flt-before-new', { at: now - 30 * 60_000 });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    const all = await read();
    expect(all.total).toBe(4);
    expect(all.filter).toBeUndefined();

    // A now-2h cutoff keeps only the 4h-old envelope: the item exactly on the
    // cutoff, the fresher one and the undated needs-you line all stay out —
    // before is exclusive where since is inclusive, and unknown never counts
    // as old.
    const older = await read({ filter: { before: now - 2 * 3_600_000 } });
    expect(older.filter).toEqual({ before: now - 2 * 3_600_000 });
    expect(older.items.map(i => i.id)).toEqual(['bus:flt-before-oldest']);
    // Per-source reports stay the unfiltered store truth.
    expect(older.sources.bus.pending).toBe(3);
    expect(older.sources['needs-you'].pending).toBe(1);

    // since and before compose into one [since, before) window: the 2h-old
    // envelope sits inside, the 4h-old one before the lower bound and the
    // 30m-old one at or after the upper bound.
    const window = await read({ filter: { since: now - 3 * 3_600_000, before: now - 90 * 60_000 } });
    expect(window.filter).toEqual({ since: now - 3 * 3_600_000, before: now - 90 * 60_000 });
    expect(window.items.map(i => i.id)).toEqual(['bus:flt-before-edge']);

    // A window that admits nothing — inverted or empty — is an honest empty
    // match, not an error and not the unfiltered list.
    const inverted = await read({ filter: { since: now - 3_600_000, before: now - 7_200_000 } });
    expect(inverted.total).toBe(0);
    expect(inverted.items).toEqual([]);
    const empty = await read({ filter: { since: now - 2 * 3_600_000, before: now - 2 * 3_600_000 } });
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);

    // A cutoff after every dated item still excludes the undated needs-you
    // line — unknown never counts as old.
    const everything = await read({ filter: { before: now + 3_600_000 } });
    expect(everything.items.map(i => i.id).sort())
      .toEqual(['bus:flt-before-edge', 'bus:flt-before-new', 'bus:flt-before-oldest']);
    expect(everything.items.some(i => i.source === 'needs-you')).toBe(false);
    expect(everything.total).toBe(3);
  });

  it('ANDs the upper bound with the other view dimensions', async () => {
    postWork('flt-b2-old', { at: now - 3 * 3_600_000 });
    postWork('flt-b2-new');
    postJob('RQ-B2', { at: now - 5 * 3_600_000 });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    const busOnly = await read({ filter: { before: now - 2 * 3_600_000, source: 'bus' } });
    expect(busOnly.items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-B2', 'bus:flt-b2-old']);

    // before ANDs with source: the undated needs-you line can never satisfy it.
    const undated = await read({ filter: { before: now - 2 * 3_600_000, source: 'needs-you' } });
    expect(undated.total).toBe(0);
    expect(undated.items).toEqual([]);

    // before ANDs with kind the same way since does.
    const kind = await read({ filter: { before: now - 2 * 3_600_000, kind: 'bus-work' } });
    expect(kind.items.map(i => i.id).sort()).toEqual(['bus-feed:RQ-B2', 'bus:flt-b2-old']);
    const handoff = await read({ filter: { before: now - 2 * 3_600_000, kind: 'bus-handoff' } });
    expect(handoff.total).toBe(0);
    expect(handoff.items).toEqual([]);
  });
});

describe('readUnifiedInbox contains filter', () => {
  it('keeps only items whose scrubbed title or detail carries the needle', async () => {
    postWork('flt-c1');                        // bus title 'fake work flt-c1'
    postJob('RQ-C1', { title: 'fix the flaky Deploy gate' });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- Rotate the deploy secret for the example app\n');
    recordTeammateText({ rowid: 90, handle: '+1555fake', text: 'can someone check the deploy?' }, runsDir, new Date(now - 60_000));

    const all = await read();
    expect(all.total).toBe(4);
    expect(all.filter).toBeUndefined();

    // Case-insensitive substring over title AND detail across every source:
    // the needs-you line, the feed job title and the teammate text all say
    // "deploy"; the plain bus envelope does not.
    const deploy = await read({ filter: { contains: 'DEPLOY' } });
    expect(deploy.filter).toEqual({ contains: 'DEPLOY' });
    expect(deploy.total).toBe(3);
    const deployIds = deploy.items.map(i => i.id);
    expect(deployIds).toContain('bus-feed:RQ-C1');
    expect(deployIds).toContain('imessage:teammate-90');
    expect(deployIds.filter(id => id.startsWith('needs-you:'))).toHaveLength(1);
    expect(deploy.items.some(i => i.id === 'bus:flt-c1')).toBe(false);
    // Per-source reports stay the unfiltered store truth.
    expect(deploy.sources.bus.pending).toBe(2);
    expect(deploy.sources['needs-you'].pending).toBe(1);
    expect(deploy.sources.imessage.pending).toBe(1);

    // The detail half of the row is searchable too: the needs-you item's
    // detail carries its 'hard limit' verdict, which its title never shows.
    const verdict = await read({ filter: { contains: 'hard limit' } });
    expect(verdict.items.map(i => i.source)).toEqual(['needs-you']);

    // Whitespace collapses on both sides, so a phrase typed with stray
    // spacing or line breaks still finds its item.
    const spaced = await read({ filter: { contains: '  deploy\n secret  ' } });
    expect(spaced.items.map(i => i.source)).toEqual(['needs-you']);

    // The act deep links are commands, never item content: every item here
    // links `phm fleet needs-resolve` or `phm comms thread`, yet a needle
    // naming only command text matches nothing.
    const commandText = await read({ filter: { contains: 'needs-resolve' } });
    expect(commandText.total).toBe(0);
    expect(commandText.items).toEqual([]);

    // A needle that normalizes to nothing imposes no text constraint — the
    // same empty-needle rule `phm messages --contains` applies.
    const blank = await read({ filter: { contains: '   ' } });
    expect(blank.filter).toEqual({ contains: '   ' });
    expect(blank.total).toBe(4);
  });

  it('ANDs the needle with the other view dimensions', async () => {
    postWork('flt-c2');
    postJob('RQ-C2', { title: 'deploy the fix' });
    recordTeammateText({ rowid: 91, handle: '+1555fake', text: 'deploy went out?' }, runsDir, new Date(now - 60_000));

    const busOnly = await read({ filter: { contains: 'deploy', source: 'bus' } });
    expect(busOnly.items.map(i => i.id)).toEqual(['bus-feed:RQ-C2']);

    const imessageOnly = await read({ filter: { contains: 'deploy', source: 'imessage' } });
    expect(imessageOnly.items.map(i => i.id)).toEqual(['imessage:teammate-91']);

    const none = await read({ filter: { contains: 'deploy', source: 'needs-you' } });
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
    expect(none.sources.bus.pending).toBe(2);
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
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- Rotate the deploy secret for the example app\n');
    expect(await command([])).toBe(0);
    const out = lines().join('\n');
    expect(out).toContain('[now] needs-you  Rotate the deploy secret');
    expect(out).toContain('phm fleet needs-resolve');
    expect(out).toContain('1 pending');
  });

  it('keeps read/post and help while refusing malformed unified invocations', async () => {
    const { command, lines } = setupCli();
    expect(await command(['--help'])).toBe(0);
    expect(lines().at(-1)).toContain('phm comms inbox [--source <name>] [--kind <name>] [--severity <info|warn|high>] [--blocking] [--job <id>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--json]');
    for (const args of [['--json', '--json'], ['unified'], ['--limit', '5'], ['bogus', '--json']]) {
      expect(await command(args)).toBe(2);
      expect(JSON.parse(lines().at(-1)!)).toEqual({ status: 'invalid' });
    }
    expect(await command(['read', '--json'])).toBe(0);
    expect(JSON.parse(lines().at(-1)!)).toEqual({ sourceState: 'missing', entries: [] });
  });

  it('filters the unified JSON view by source, severity and blocking', async () => {
    const { command, json } = setupCli();
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- Rotate the deploy secret for the example app\n');
    postWork('cli-bus', { priority: 'P0' });
    postWork('cli-bus2');

    expect(await command(['--source', 'bus', '--json'])).toBe(0);
    let report = json();
    expect(report.filter).toEqual({ source: 'bus' });
    expect(report.total).toBe(2);
    expect(report.items.every(i => i.source === 'bus')).toBe(true);
    expect(report.sources['needs-you'].pending).toBe(1);

    expect(await command(['--severity', 'high', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ severity: 'high' });
    expect(report.total).toBe(1);
    expect(report.items[0]!.id).toBe('bus:cli-bus');

    expect(await command(['--blocking', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ blocking: true });
    expect(report.total).toBe(1);
    expect(report.items[0]!.source).toBe('needs-you');

    expect(await command(['--source', 'bus', '--severity', 'info', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ source: 'bus', severity: 'info' });
    expect(report.total).toBe(1);
    expect(report.items[0]!.id).toBe('bus:cli-bus2');
  });

  it('filters the unified JSON view by job id', async () => {
    const { command, json } = setupCli();
    postJob('RQ-CLI-1');
    postJob('RQ-CLI-2');
    postWork('cli-plain');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    expect(await command(['--job', 'RQ-CLI-1', '--json'])).toBe(0);
    let report = json();
    expect(report.filter).toEqual({ job: 'RQ-CLI-1' });
    expect(report.total).toBe(1);
    expect(report.items.map(i => i.id)).toEqual(['bus-feed:RQ-CLI-1']);
    expect(report.items[0]!.jobIds).toEqual(['RQ-CLI-1']);
    // The per-source counts stay the unfiltered store truth.
    expect(report.sources.bus.pending).toBe(3);
    expect(report.sources['needs-you'].pending).toBe(1);

    // --job ANDs with the other view filters.
    expect(await command(['--job', 'RQ-CLI-1', '--source', 'bus', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ job: 'RQ-CLI-1', source: 'bus' });
    expect(report.total).toBe(1);
    expect(await command(['--job', 'RQ-CLI-1', '--source', 'needs-you', '--json'])).toBe(0);
    report = json();
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
  });

  it('filters the unified JSON view by --since', async () => {
    const { command, json } = setupCli();
    postWork('cli-since-old', { at: now - 3_600_000 });
    postWork('cli-since-new');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    expect(await command(['--since', '15m', '--json'])).toBe(0);
    let report = json();
    expect(report.filter).toEqual({ since: now - 15 * 60_000 });
    expect(report.items.map(i => i.id)).toEqual(['bus:cli-since-new']);
    // needs-you keeps no timestamp — unknown never counts as new — and the
    // per-source counts stay the unfiltered store truth.
    expect(report.sources['needs-you'].pending).toBe(1);
    expect(report.sources.bus.pending).toBe(2);

    // The cutoff is inclusive and takes every parseSince spelling.
    expect(await command(['--since', String(now - 3_600_000), '--json'])).toBe(0);
    report = json();
    expect(report.items.map(i => i.id).sort()).toEqual(['bus:cli-since-new', 'bus:cli-since-old']);
    expect(await command(['--since', '2026-11-07T11:30:00Z', '--json'])).toBe(0);
    report = json();
    expect(report.items.map(i => i.id)).toEqual(['bus:cli-since-new']);
    expect(await command(['--since', '1h', '--json'])).toBe(0);
    report = json();
    expect(report.items).toHaveLength(2);

    // --since ANDs with the other view filters.
    expect(await command(['--since', '15m', '--source', 'needs-you', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ since: now - 15 * 60_000, source: 'needs-you' });
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
  });

  it('filters the unified JSON view by --before', async () => {
    const { command, json } = setupCli();
    postWork('cli-before-old', { at: now - 3_600_000 });
    postWork('cli-before-new');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    // --before keeps only items whose appearance time is strictly before the
    // cutoff: the hour-old envelope, never the fresh one or the undated
    // needs-you line — unknown never counts as old.
    expect(await command(['--before', '15m', '--json'])).toBe(0);
    let report = json();
    expect(report.filter).toEqual({ before: now - 15 * 60_000 });
    expect(report.items.map(i => i.id)).toEqual(['bus:cli-before-old']);
    expect(report.sources['needs-you'].pending).toBe(1);
    expect(report.sources.bus.pending).toBe(2);

    // The bound is exclusive and takes every parseSince spelling: the old
    // envelope sits exactly on this cutoff and stays out.
    expect(await command(['--before', String(now - 3_600_000), '--json'])).toBe(0);
    report = json();
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
    expect(await command(['--before', '2026-11-07T11:30:00Z', '--json'])).toBe(0);
    report = json();
    expect(report.items.map(i => i.id)).toEqual(['bus:cli-before-old']);

    // --since and --before compose into one [since, before) window.
    expect(await command(['--since', '2h', '--before', '15m', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ since: now - 2 * 3_600_000, before: now - 15 * 60_000 });
    expect(report.items.map(i => i.id)).toEqual(['bus:cli-before-old']);
    expect(await command(['--since', '15m', '--before', '2h', '--json'])).toBe(0);
    report = json();
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);

    // --before ANDs with the other view filters.
    expect(await command(['--before', '15m', '--source', 'needs-you', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ before: now - 15 * 60_000, source: 'needs-you' });
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
  });

  it('filters the unified JSON view by --contains text', async () => {
    const { command, json } = setupCli();
    postWork('cli-contains-bus');
    postJob('RQ-CLI-C', { title: 'rotate the deploy credentials' });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    recordTeammateText({ rowid: 92, handle: '+1555fake', text: 'deploy window at noon?' }, runsDir, new Date(now - 60_000));

    expect(await command(['--contains', 'DEPLOY', '--json'])).toBe(0);
    let report = json();
    expect(report.filter).toEqual({ contains: 'DEPLOY' });
    expect(report.items.map(i => i.id).sort())
      .toEqual(['bus-feed:RQ-CLI-C', 'imessage:teammate-92']);
    // The per-source counts stay the unfiltered store truth.
    expect(report.sources.bus.pending).toBe(2);
    expect(report.sources.imessage.pending).toBe(1);
    expect(report.sources['needs-you'].pending).toBe(1);

    // Phrases with spaces are one needle; the match is a case-insensitive
    // substring over the scrubbed title/detail the row shows.
    expect(await command(['--contains', 'deploy window', '--json'])).toBe(0);
    report = json();
    expect(report.items.map(i => i.id)).toEqual(['imessage:teammate-92']);

    // --contains ANDs with the other view filters.
    expect(await command(['--contains', 'deploy', '--source', 'bus', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ contains: 'deploy', source: 'bus' });
    expect(report.items.map(i => i.id)).toEqual(['bus-feed:RQ-CLI-C']);
    expect(await command(['--contains', 'deploy', '--source', 'needs-you', '--json'])).toBe(0);
    report = json();
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
  });

  it('filters the unified JSON view by --kind', async () => {
    const { command, json } = setupCli();
    postWork('cli-kind-work');
    const handoffId = postV2Body({ kind: 'worker-handoff', taskId: 'RQ-CLI-K', prompt: 'fake handoff' },
      { to: 'agent:worker-9' });
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    expect(await command(['--kind', 'bus-handoff', '--json'])).toBe(0);
    let report = json();
    expect(report.filter).toEqual({ kind: 'bus-handoff' });
    expect(report.items.map(i => i.id)).toEqual([`bus-handoff:${handoffId}`]);
    expect(report.items[0]!.source).toBe('bus');
    // The per-source counts stay the unfiltered store truth.
    expect(report.sources.bus.pending).toBe(2);
    expect(report.sources['needs-you'].pending).toBe(1);

    // --kind ANDs with --source: agreeing keeps the rows, disagreeing is an honest empty.
    expect(await command(['--kind', 'bus-work', '--source', 'bus', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ kind: 'bus-work', source: 'bus' });
    expect(report.items.map(i => i.id)).toEqual(['bus:cli-kind-work']);
    expect(await command(['--kind', 'bus-handoff', '--source', 'needs-you', '--json'])).toBe(0);
    report = json();
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);

    // A kind that is also a source name is not a kind — sources and kinds are distinct dimensions.
    expect(await command(['--kind', 'bus', '--json'])).toBe(2);
    expect(await command(['--kind', 'needs-you', '--json'])).toBe(0);
    report = json();
    expect(report.items.map(i => i.kind)).toEqual(['needs-you']);
  });

  it('labels the human footer with the applied filter and unfiltered counts', async () => {
    const { command, lines } = setupCli();
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    postWork('cli-human');
    expect(await command(['--source', 'bus'])).toBe(0);
    const out = lines().join('\n');
    expect(out).toContain('1 pending matching source=bus');
    expect(out).toContain('unfiltered:');
    expect(out).toContain('needs-you 1');
    // A filter matching nothing says so instead of "Nothing pending."
    expect(await command(['--source', 'gmail'])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending matching source=gmail.');
    postJob('RQ-CLI-H');
    expect(await command(['--job', 'RQ-CLI-H'])).toBe(0);
    expect(lines().join('\n')).toContain('1 pending matching job=RQ-CLI-H');
    expect(await command(['--job', 'RQ-NOPE'])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending matching job=RQ-NOPE.');
    // --kind labels the kind verbatim in the same footer slot.
    expect(await command(['--kind', 'bus-work'])).toBe(0);
    expect(lines().join('\n')).toContain('2 pending matching kind=bus-work');
    expect(await command(['--kind', 'bus-handoff'])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending matching kind=bus-handoff.');
    // --contains labels the needle verbatim in the same footer slot; the
    // feed job's title carries the job id, so it is the one match.
    expect(await command(['--contains', 'RQ-CLI-H'])).toBe(0);
    expect(lines().join('\n')).toContain('1 pending matching contains=RQ-CLI-H');
    expect(await command(['--contains', 'no-such-text'])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending matching contains=no-such-text.');
    // --since labels the resolved cutoff, not the relative spelling; the
    // undated needs-you line stays out of the match.
    expect(await command(['--since', '15m'])).toBe(0);
    expect(lines().join('\n')).toContain(`2 pending matching since=${new Date(now - 15 * 60_000).toISOString()}`);
    // A future cutoff matches nothing dated — "Nothing pending", not a guess.
    expect(await command(['--since', String(now + 60_000)])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending matching since=' +
      `${new Date(now + 60_000).toISOString()}.`);
    // --before labels the resolved cutoff the same way; nothing here predates it.
    expect(await command(['--before', '15m'])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending matching before=' +
      `${new Date(now - 15 * 60_000).toISOString()}.`);
  });

  it('refuses malformed unified filter invocations', async () => {
    const { command, lines } = setupCli();
    for (const args of [
      ['--source'], ['--source', 'bogus'], ['--source', 'bus', '--source', 'bus'],
      ['--severity'], ['--severity', 'P0'], ['--severity', 'warn', '--severity', 'info'],
      ['--blocking', '--blocking'], ['--json', '--source'], ['--source', '--json'],
      ['--source', 'read'], ['--blocking', 'true'],
      ['--job'], ['--job', ''], ['--job', '--json'], ['--job', 'bad job'],
      ['--job', 'x'.repeat(129)], ['--job', 'RQ-1', '--job', 'RQ-2'],
      ['--job', 'RQ-1', '--source'], ['--json', '--job'],
      ['--since'], ['--since', '--json'], ['--since', 'bogus'], ['--since', '-5m'],
      ['--since', '15m', '--since', '15m'], ['--json', '--since'],
      ['--since', '15m', '--job'],
      ['--before'], ['--before', '--json'], ['--before', 'bogus'], ['--before', '-5m'],
      ['--before', '15m', '--before', '15m'], ['--json', '--before'],
      ['--before', '15m', '--job'], ['--before', '15m', '--since'],
      ['--kind'], ['--kind', 'bogus'], ['--kind', 'bus'], ['--kind', 'bus-work', '--kind', 'bus-handoff'],
      ['--kind', '--json'], ['--json', '--kind'], ['--kind', 'read'],
      ['--contains'], ['--contains', ''], ['--contains', '   '], ['--contains', '--json'],
      ['--contains', 'x'.repeat(513)], ['--contains', 'a', '--contains', 'b'],
      ['--contains', 'deploy', '--job'], ['--json', '--contains'],
    ]) {
      expect(await command(args), args.join(' ')).toBe(2);
      expect(JSON.parse(lines().at(-1)!)).toEqual({ status: 'invalid' });
    }
  });
});
