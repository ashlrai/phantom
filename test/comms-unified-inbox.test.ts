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
import { appendDraft as appendCommsDraft, writeInbox as writeCommsInbox, type CommsDraft } from '../src/core/comms-agent/store.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { emptyOwnerSettings, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, postOwnerNotice, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { readUnifiedInbox, UNIFIED_INBOX_MAX_ITEMS, type DispatchStuckSourceRead, type JobsStuckSourceRead, type QueueParkedRead, type RouterQueueStuckRead, type StuckFixesSourceRead, type StrandedWorkSourceRead, type UnifiedInbox, type UnifiedInboxOptions } from '../src/core/comms/unified-inbox.js';
import type { ParkedGroup, ParkedMetDep, ParkedUnmetDep } from '../src/core/fleet/runs-parked-queue.js';
import type { StuckFixRow } from '../src/core/fleet/stuck-fixes.js';
import type { StrandedItem } from '../src/core/fleet/stranded-work.js';
import type { StuckJob as RunningStuckJob } from '../src/core/fleet/running-stuck.js';
import type { StuckJob as DispatchStuckJob } from '../src/core/fleet/stuck-jobs.js';
import type { ProposalApprovalItem, Section, TeamApprovalItem } from '../src/core/approvals/surface.js';
import type { SeatHandoff, SeatHandoffPlanEntry, SeatHandoffsPlan } from '../src/core/bots/seats.js';
import type { CommsRequest, CommsRequestsRead } from '../src/core/comms/requests.js';
import { DEFAULT_TEAM } from '../src/core/teams/tools.js';
import { markTeammateTextsAnswered, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { writeEmailDropConfig, type EmailDropConfig } from '../src/core/comms/email-drop-config.js';
import { EMAIL_OUTBOX_MAX_BYTES } from '../src/core/comms/email-outbox.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { createAgentChannel, registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { createBusMailbox, type BusMailboxPendingMessage } from '../src/core/fleet/bus-mailbox.js';
import { BusBoard, type BusBoardPendingPeers, type BusBoardPendingTask, type BusBoardTaskHold } from '../src/core/fleet/bus-board.js';
import type { BusBoardDelivery } from '../src/core/fleet/bus-delivery.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { AgentConversations } from '../src/core/fleet/agent-conversations.js';
import type { SlackJournalRead, SlackObservation } from '../src/core/agents/slack-journal.js';
import type { SlackSendReceiptRead } from '../src/core/agents/slack-send-receipts.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import type { LeaderThreadUndeliveredItem, LeaderThreadUndeliveredRead } from '../src/core/vision/leader-thread.js';
import type { LeaderNetworkDigestFact, LeaderNetworkRequestFact, LeaderNetworkStateRead } from '../src/core/agents/leader-network-read.js';
import type { LeaderReplyPending, LeaderRepliesLedgerRead } from '../src/core/comms/leader-replies-ledger.js';
import { replyTextHash } from '../src/core/fleet/mason-outbox.js';
import type { FleetAssignment, FleetCoordinationPending, FleetMessage, FleetPendingReturn } from '../src/core/fleet/coordination.js';
import type { ClaimDriftRow, ClaimStoreDrift } from '../src/core/fleet/claim-store-drift.js';
import type { SessionHandoffList, SessionHandoffListEntry } from '../src/core/agents/session-handoff.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';
import type { WorkItemState } from '../src/core/comms/work-item-state.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
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
  // The owner-pair state file lives under the real owner config dir; pin a
  // verified-absent read so the suite stays hermetic. The source has its own
  // describe block below with an injected reader.
  readOwnerPair: () => ({ status: 'missing' }),
  // The work board classifies every durable bus envelope as a request, so the
  // fixtures this suite posts would all list as RECEIVED; pin a verified-empty
  // board so only the dedicated describe block exercises the real projection.
  readWorkBoard: () => ({ items: [], inbox: 'ok', truncated: false, claims: 'available', coordination: 'available' }),
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
        'owner-pair': { state: 'missing', pending: 0 },
        imessage: { state: 'missing', pending: 0 },
        'teammate-tasks': { state: 'missing', pending: 0 },
        drafts: { state: 'healthy', pending: 0 },
        'comms-mail': { state: 'healthy', pending: 0 },
        bus: { state: 'missing', pending: 0 },
        mailbox: { state: 'missing', pending: 0 },
        board: { state: 'missing', pending: 0 },
        conversations: { state: 'missing', pending: 0 },
        wakes: { state: 'healthy', pending: 0 },
        seats: { state: 'missing', pending: 0 },
        'peer-dispatch': { state: 'missing', pending: 0 },
        'peer-inbox': { state: 'missing', pending: 0 },
        'session-handoff': { state: 'missing', pending: 0 },
        'org-outbox': { state: 'missing', pending: 0 },
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

  it('lists comms-agent inbox mail no reply draft covers, deduped against draft records', async () => {
    await writeCommsInbox(runsDir, [
      { id: 'm-1', transport: 'email', from: 'person@example.com', subject: 'fake hello', body: 'fake body one' },
      { id: 'm-2', transport: 'imessage', from: '+1555handle', subject: 'fake unclassed', body: 'fake body two' },
      { id: 'm-3', transport: 'linkedin', from: 'pw@example.com', subject: 'fake answered', body: 'fake body three' },
    ]);
    // m-1's pending draft already lists under `drafts`; m-3's sent draft means
    // the reply was delivered — both suppress their inbox row here.
    await appendCommsDraft(runsDir, { id: 'c-1', status: 'pending', transport: 'email', recipient: 'person@example.com', subject: 'Re: fake hello', body: 'fake reply', messageId: 'm-1', createdAt: new Date(now - 60_000).toISOString() });
    await appendCommsDraft(runsDir, { id: 'c-2', status: 'sent', transport: 'linkedin', recipient: 'pw@example.com', subject: 'Re: fake answered', body: 'fake reply', messageId: 'm-3', createdAt: new Date(now - 120_000).toISOString(), resolvedAt: new Date(now - 30_000).toISOString() });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'comms-mail');
    expect(items.map(i => i.id)).toEqual(['comms-mail:m-2']);
    expect(items[0]).toMatchObject({
      kind: 'comms-mail', severity: 'info', blocking: false,
      title: 'Comms mail via imessage', detail: 'fake unclassed',
      since: null, expiresAt: null,
      act: ['phm comms-agent run', 'phm comms-agent drafts'],
    });
    // The sender is a handle and the body stays private: neither reaches the item.
    expect(JSON.stringify(items)).not.toContain('+1555handle');
    expect(JSON.stringify(items)).not.toContain('fake body');
    expect(inbox.sources['comms-mail']).toEqual({ state: 'healthy', pending: 1 });
  });

  it('reports the comms-mail source unavailable on a malformed inbox and degraded when draft coverage cannot be read', async () => {
    mkdirSync(join(runsDir, 'comms-agent'), { recursive: true, mode: 0o700 });
    writeFileSync(join(runsDir, 'comms-agent', 'inbox.json'), 'not json', { mode: 0o600 });
    const bad = await read();
    expect(bad.sources['comms-mail']).toEqual({ state: 'unavailable', pending: null });
    expect(bad.items.filter(i => i.source === 'comms-mail')).toHaveLength(0);

    // A drafts-store failure leaves coverage unproven: the message lists
    // even though a draft record names it — degraded, never suppressed on a guess.
    await writeCommsInbox(runsDir, [
      { id: 'm-9', transport: 'email', from: 'a@example.com', subject: 'fake pending', body: 'fake body' },
    ]);
    await appendCommsDraft(runsDir, { id: 'c-9', status: 'pending', transport: 'email', recipient: 'a@example.com', subject: 'Re: fake pending', body: 'fake reply', messageId: 'm-9', createdAt: new Date(now).toISOString() });
    const degraded = await read({ listCommsDrafts: async () => { throw new Error('unreadable'); } });
    expect(degraded.sources['comms-mail']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'comms-mail').map(i => i.id)).toEqual(['comms-mail:m-9']);
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
    seatId: 'devin-review', participantId: 'devin-review', state: 'draining', eligible: true,
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

describe('readUnifiedInbox slack sends', () => {
  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);
  const receipt = (over: Partial<SentReceipt> = {}): SentReceipt => ({
    key: KEY_A, channel: 'C0123ABCD', state: 'attempted',
    thread: '1762000000.000100', ...over,
  });
  const sends = (receipts: SentReceipt[], state: 'ok' | 'missing' | 'degraded' = 'ok'): SlackSendReceiptRead => ({ state, receipts });
  const pinned = {
    readRequests: () => ({ status: 'missing' as const, requests: [] }),
  };
  const readWith = (readSlackSends: () => SlackSendReceiptRead) =>
    readUnifiedInbox({ runsDir, busRoot, now: () => now, ...pinned, readSlackSends });

  it('lists attempted sends as warn items and keeps proved sends out', async () => {
    const inbox = await readWith(() => sends([
      receipt(),
      // A sent receipt is a proved delivery — history, never pending.
      receipt({ key: KEY_B, state: 'sent', ts: '1762000001.000100' }),
    ]));
    expect(inbox.sources['slack-sends']).toEqual({ state: 'healthy', pending: 1 });
    const items = inbox.items.filter(i => i.source === 'slack-sends');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `slack-sends:${KEY_A}`,
      kind: 'slack-send-unconfirmed', severity: 'warn', blocking: false,
      title: 'Slack send unconfirmed',
      detail: 'channel C0123ABCD · thread 1762000000.000100',
      since: null, expiresAt: null,
      act: [
        'phm channels slack status --json',
        'phm fleet slack-trace --channel C0123ABCD --thread 1762000000.000100 --json',
        'phm channels slack run --seconds 60 --json',
      ],
    });
    // Receipts carry channel/thread/key evidence only — never send text,
    // digests or client ids.
    expect(JSON.stringify(items[0])).not.toContain('digest');
    expect(JSON.stringify(items[0])).not.toContain('clientId');
  });

  it('scopes the trace link to the channel alone when the send carried no thread', async () => {
    const inbox = await readWith(() => sends([receipt({ thread: undefined })]));
    const item = inbox.items.find(i => i.source === 'slack-sends')!;
    expect(item.detail).toBe('channel C0123ABCD');
    expect(item.act).toEqual([
      'phm channels slack status --json',
      'phm fleet slack-trace --channel C0123ABCD --json',
      'phm channels slack run --seconds 60 --json',
    ]);
  });

  it('keeps only the bare reads when receipt ids fail the shape guard', async () => {
    const inbox = await readWith(() => sends([receipt({ channel: 'bad id; touch /tmp/x', thread: 'also bad' })]));
    const item = inbox.items.find(i => i.source === 'slack-sends')!;
    expect(item.act).toEqual([
      'phm channels slack status --json',
      'phm fleet slack-trace --json',
      'phm channels slack run --seconds 60 --json',
    ]);
    expect(item.detail).toBe('channel bad id; touch /tmp/x');
  });

  it('collapses duplicate keys and identical unkeyed rows to one item each', async () => {
    const inbox = await readWith(() => sends([
      receipt(),
      receipt(),
      // A seam row without a store key still lists under a content hash.
      receipt({ key: undefined }),
      receipt({ key: undefined }),
      receipt({ key: undefined, thread: '1762000000.000999' }),
    ]));
    const items = inbox.items.filter(i => i.source === 'slack-sends');
    expect(items).toHaveLength(3);
    expect(items.filter(i => i.id === `slack-sends:${KEY_A}`)).toHaveLength(1);
    expect(new Set(items.map(i => i.id)).size).toBe(3);
  });

  it('reports the send-store state as the source state, never a fabricated healthy', async () => {
    const missing = await readWith(() => sends([], 'missing'));
    expect(missing.sources['slack-sends']).toEqual({ state: 'missing', pending: 0 });
    const degraded = await readWith(() => sends([receipt()], 'degraded'));
    expect(degraded.sources['slack-sends']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'slack-sends')).toHaveLength(1);
  });

  it('reports unavailable on a throwing seam while other sources still list', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readSlackSends: () => { throw new Error('boom'); },
    });
    expect(inbox.sources['slack-sends']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'slack-sends')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('filters by its own source and kind like every other source', async () => {
    const inbox = await readWith(() => sends([receipt()]));
    const bySource = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readSlackSends: () => sends([receipt()]),
      filter: { source: 'slack-sends' },
    });
    expect(bySource.items.map(i => i.id)).toEqual([`slack-sends:${KEY_A}`]);
    expect(bySource.filter).toEqual({ source: 'slack-sends' });
    const byKind = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readSlackSends: () => sends([receipt()]),
      filter: { kind: 'slack-send-unconfirmed' },
    });
    expect(byKind.items.map(i => i.id)).toEqual([`slack-sends:${KEY_A}`]);
    expect(inbox.items.filter(i => i.kind === 'slack-send-unconfirmed')).toHaveLength(1);
  });
});

describe('readUnifiedInbox leader deliveries', () => {
  const AT = '2026-11-07T06:00:00.000Z';
  const entry = (over: Partial<LeaderThreadUndeliveredItem> = {}): LeaderThreadUndeliveredItem => ({
    id: 'lt-20261107060000-abc123', at: AT, channel: 'system', kind: 'memo',
    text: 'Memo lm-20261107060000-aaaaaa — Bottleneck: fake bottleneck', telegram: 'failed', attempts: 3, ...over,
  });
  const pinned = {
    readRequests: () => ({ status: 'missing' as const, requests: [] }),
  };
  const readWith = (readLeaderUndelivered: NonNullable<UnifiedInboxOptions['readLeaderUndelivered']>) =>
    readUnifiedInbox({ runsDir, busRoot, now: () => now, ...pinned, readLeaderUndelivered });
  const ok = (items: LeaderThreadUndeliveredItem[]): LeaderThreadUndeliveredRead => ({ status: 'ok', items });

  it('lists failed and stalled deliveries as warn items naming kind, state and acts', async () => {
    const inbox = await readWith(() => ok([
      entry(),
      entry({ id: 'lt-20261107070000-def456', kind: 'question', channel: 'telegram', telegram: 'pending', attempts: 1, text: 'fake question text' }),
      entry({ id: 'lt-20261107080000-ghi789', kind: 'update', telegram: 'failed', attempts: 1 }),
    ]));
    expect(inbox.sources['leader-delivery']).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'leader-delivery');
    expect(items).toHaveLength(3);
    const failed = items.find(i => i.id === 'leader-delivery:lt-20261107060000-abc123')!;
    expect(failed).toMatchObject({
      kind: 'leader-message-undelivered', severity: 'warn', blocking: false,
      title: 'Leader memo Telegram delivery failed',
      detail: 'system · Telegram failed after 3 send attempts · "Memo lm-20261107060000-aaaaaa — Bottleneck: fake bottleneck"',
      since: AT, expiresAt: null,
      act: ['phm channels --json', 'phm comms cycle', 'phm comms send-owner --text "<same message text>"'],
    });
    const stalled = items.find(i => i.id === 'leader-delivery:lt-20261107070000-def456')!;
    expect(stalled).toMatchObject({
      title: 'Leader question Telegram delivery stalled',
      detail: 'telegram · Telegram pending past the 72 h drain window — the comms drain no longer offers it · "fake question text"',
    });
    // Singular attempt count reads correctly.
    expect(items.find(i => i.id === 'leader-delivery:lt-20261107080000-ghi789')!.detail).toContain('failed after 1 send attempt');
  });

  it('scrubs secret-shaped text out of the item detail', async () => {
    const secret = `sk-ant-api03-${'x'.repeat(24)}`;
    const inbox = await readWith(() => ok([entry({ text: `memo mentions ${secret} inline` })]));
    const item = inbox.items.find(i => i.source === 'leader-delivery')!;
    expect(JSON.stringify(item)).not.toContain(secret);
    expect(item.detail).toContain('[REDACTED]');
  });

  it('reports the read state as the source state, never a fabricated healthy', async () => {
    const missing = await readWith(() => ({ status: 'missing' as const, items: [] }));
    expect(missing.sources['leader-delivery']).toEqual({ state: 'missing', pending: 0 });
    const degraded = await readWith(() => ({ status: 'degraded' as const, items: [entry()] }));
    expect(degraded.sources['leader-delivery']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'leader-delivery')).toHaveLength(1);
    const unavailable = await readWith(() => ({ status: 'unavailable' as const, items: [] }));
    expect(unavailable.sources['leader-delivery']).toEqual({ state: 'unavailable', pending: null });
  });

  it('reports unavailable on a throwing seam while other sources still list', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readLeaderUndelivered: () => { throw new Error('boom'); },
    });
    expect(inbox.sources['leader-delivery']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'leader-delivery')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('filters by its own source and kind like every other source', async () => {
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readLeaderUndelivered: () => ok([entry()]),
      filter: { source: 'leader-delivery' },
    });
    expect(inbox.items.map(i => i.id)).toEqual(['leader-delivery:lt-20261107060000-abc123']);
    expect(inbox.filter).toEqual({ source: 'leader-delivery' });
    const byKind = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readLeaderUndelivered: () => ok([entry()]),
      filter: { kind: 'leader-message-undelivered' },
    });
    expect(byKind.items.map(i => i.id)).toEqual(['leader-delivery:lt-20261107060000-abc123']);
    expect(inbox.items.filter(i => i.kind === 'leader-message-undelivered')).toHaveLength(1);
  });
});

describe('readUnifiedInbox leader network', () => {
  const REQ_A = 'a'.repeat(64);
  const REQ_B = 'b'.repeat(64);
  const REQ_C = 'c'.repeat(64);
  const DIGEST_A = 'd'.repeat(64);
  const request = (over: Partial<LeaderNetworkRequestFact> = {}): LeaderNetworkRequestFact => ({
    requestId: REQ_A, channel: 'telegram', to: 'leader',
    receivedAt: now - 3_600_000, text: 'fake owner request',
    inbox: true, bus: true, reply: null, jobIds: [], ...over,
  });
  const digest = (over: Partial<LeaderNetworkDigestFact> = {}): LeaderNetworkDigestFact => ({
    key: DIGEST_A, channel: 'telegram', day: '2026-11-06',
    at: now - 7_200_000, sent: false, attempted: true, ...over,
  });
  const ok = (requests: LeaderNetworkRequestFact[], digests: LeaderNetworkDigestFact[] = []): LeaderNetworkStateRead =>
    ({ status: 'ok', requests, digests });
  const pinned = {
    readRequests: () => ({ status: 'missing' as const, requests: [] }),
  };
  const readWith = (readLeaderNetwork: NonNullable<UnifiedInboxOptions['readLeaderNetwork']>) =>
    readUnifiedInbox({ runsDir, busRoot, now: () => now, ...pinned, readLeaderNetwork });

  it('lists awaiting requests, incomplete ingests, unconfirmed replies and digests; proved routes stay out', async () => {
    const inbox = await readWith(() => ok([
      // Verified owner request fully ingested, unanswered — the leader's queue.
      request(),
      // Same shape but the bus mirror never landed — incomplete, not awaiting.
      request({ requestId: REQ_B, inbox: true, bus: false, text: null }),
      // Reply recorded, delivery attempt ambiguous — reconcile, never retry.
      request({ requestId: REQ_C, reply: { delivered: false, attempted: true, at: now - 1_800_000 } }),
      // Reply recorded but delivery failed non-ambiguously — still pending,
      // the network retries it on the next reply pass.
      request({ requestId: '9'.repeat(64), reply: { delivered: false, attempted: false, at: now - 600_000 } }),
      // Delivered reply and a non-leader route with its bus publish — history.
      request({ requestId: 'e'.repeat(64), reply: { delivered: true, attempted: true, at: now - 900_000 } }),
      request({ requestId: 'f'.repeat(64), to: 'worker', inbox: false, bus: true }),
    ], [digest()]));
    expect(inbox.sources['leader-network']).toEqual({ state: 'healthy', pending: 5 });
    const items = inbox.items.filter(i => i.source === 'leader-network');
    expect(items).toHaveLength(5);
    const awaiting = items.find(i => i.id === `leader-network:request-${REQ_A}`)!;
    expect(awaiting).toMatchObject({
      kind: 'leader-request', severity: 'warn', blocking: false,
      title: 'fake owner request',
      detail: `leader network · via telegram · awaiting reply · received ${new Date(now - 3_600_000).toISOString()}`,
      since: new Date(now - 3_600_000).toISOString(), expiresAt: null,
      act: ['phm leader inbox --json', 'phm comms thread'],
    });
    const incomplete = items.find(i => i.id === `leader-network:incomplete-${REQ_B}`)!;
    expect(incomplete).toMatchObject({
      kind: 'leader-request-incomplete', severity: 'warn', blocking: false,
      title: 'Leader request delivery incomplete via telegram',
      detail: expect.stringContaining('unproven: bus mirror'),
    });
    const unconfirmed = items.find(i => i.id === `leader-network:reply-${REQ_C}`)!;
    expect(unconfirmed).toMatchObject({
      kind: 'leader-reply-unconfirmed', severity: 'warn', blocking: false,
      title: 'Leader reply delivery unconfirmed via telegram',
      detail: expect.stringContaining('delivery outcome unknown — reconcile before retry'),
      since: new Date(now - 1_800_000).toISOString(),
    });
    const retryable = items.find(i => i.id === `leader-network:request-${'9'.repeat(64)}`)!;
    expect(retryable).toMatchObject({
      kind: 'leader-request', severity: 'warn', blocking: false,
      detail: expect.stringContaining('reply recorded'),
    });
    expect(retryable.detail).toContain('delivery incomplete — awaiting retry');
    const digestItem = items.find(i => i.id === `leader-network:digest-${DIGEST_A}`)!;
    expect(digestItem).toMatchObject({
      kind: 'leader-digest-unconfirmed', severity: 'warn', blocking: false,
      title: 'Leader away-digest delivery unconfirmed via telegram',
      detail: expect.stringContaining('day 2026-11-06'),
      act: ['phm leader inbox --json'],
    });
    // A sent digest and an attempted-then-cleared one are proved or retryable.
    const clean = await readWith(() => ok([], [
      digest({ key: '1'.repeat(64), sent: true }),
      digest({ key: '2'.repeat(64), attempted: false }),
    ]));
    expect(clean.items.filter(i => i.source === 'leader-network')).toHaveLength(0);
    expect(clean.sources['leader-network']).toEqual({ state: 'healthy', pending: 0 });
  });

  it('names the missing legs for non-leader routes and leader inbox gaps', async () => {
    const inbox = await readWith(() => ok([
      // Non-leader route: only the bus publish is a required leg.
      request({ requestId: REQ_A, to: 'worker', inbox: false, bus: false }),
      // Leader route missing both legs names both.
      request({ requestId: REQ_B, inbox: false, bus: false, text: 'second fake request' }),
      // Leader route missing only the inbox append.
      request({ requestId: REQ_C, inbox: false, bus: true }),
    ]));
    const items = inbox.items.filter(i => i.source === 'leader-network');
    expect(items).toHaveLength(3);
    expect(items.find(i => i.id === `leader-network:incomplete-${REQ_A}`)!.detail).toContain('unproven: bus publish');
    expect(items.find(i => i.id === `leader-network:incomplete-${REQ_B}`)!.detail).toContain('unproven: inbox append, bus mirror');
    expect(items.find(i => i.id === `leader-network:incomplete-${REQ_C}`)!.detail).toContain('unproven: inbox append');
  });

  it('carries job citations from the request body and never owner identifiers', async () => {
    const inbox = await readWith(() => ok([
      request({ jobIds: ['RQ-LEADER-1', 'RQ-LEADER-2'] }),
    ]));
    const item = inbox.items.find(i => i.source === 'leader-network')!;
    expect(item.jobIds).toEqual(['RQ-LEADER-1', 'RQ-LEADER-2']);
    const serialized = JSON.stringify(item);
    // Route keys are sha256 digests; recipient ids, channel refs and raw
    // envelopes never reach an item.
    expect(serialized).not.toContain('recipient');
    expect(serialized).not.toContain('channelRef');
    expect(serialized).not.toContain('fingerprint');
  });

  it('scrubs secret-shaped request text out of the item title', async () => {
    const secret = `sk-ant-api03-${'x'.repeat(24)}`;
    const inbox = await readWith(() => ok([request({ text: `please rotate ${secret} now` })]));
    const item = inbox.items.find(i => i.source === 'leader-network')!;
    expect(JSON.stringify(item)).not.toContain(secret);
    expect(item.title).toContain('[REDACTED]');
  });

  it('reports the read state as the source state, never a fabricated healthy', async () => {
    const missing = await readWith(() => ({ status: 'missing' as const }));
    expect(missing.sources['leader-network']).toEqual({ state: 'missing', pending: 0 });
    const unavailable = await readWith(() => ({ status: 'unavailable' as const }));
    expect(unavailable.sources['leader-network']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'leader-network')).toHaveLength(0);
  });

  it('reports unavailable on a throwing seam while other sources still list', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readLeaderNetwork: () => { throw new Error('boom'); },
    });
    expect(inbox.sources['leader-network']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'leader-network')).toHaveLength(0);
    expect(inbox.items.filter(i => i.source === 'needs-you')).toHaveLength(1);
  });

  it('filters by its own source and kind like every other source', async () => {
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readLeaderNetwork: () => ok([request(), request({ requestId: REQ_B, inbox: false, bus: true })]),
      filter: { source: 'leader-network' },
    });
    expect(inbox.items.map(i => i.id).sort()).toEqual([
      `leader-network:incomplete-${REQ_B}`, `leader-network:request-${REQ_A}`,
    ]);
    expect(inbox.filter).toEqual({ source: 'leader-network' });
    const byKind = await readUnifiedInbox({
      runsDir, busRoot, now: () => now, ...pinned,
      readLeaderNetwork: () => ok([request()]),
      filter: { kind: 'leader-request' },
    });
    expect(byKind.items.map(i => i.id)).toEqual([`leader-network:request-${REQ_A}`]);
    expect(inbox.items.filter(i => i.kind === 'leader-request')).toHaveLength(1);
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

describe('readUnifiedInbox peer inbox', () => {
  // `root` is assigned in beforeEach, so every path resolves lazily at call time.
  const agentnetDir = () => join(root, 'agentnet');
  const bindingsFile = () => join(agentnetDir(), 'bindings.json');
  const binding = (n: number, expiresAt: number) => ({ callsign: `agent${n}`, lane: `lane-${n}`,
    sessionId: `session-${n}`, sessionHash: n.toString(16).padStart(64, 'a'),
    expiresAt, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' });
  /** The bindings file `readPeerBindings` validates — mode 0600 under a private dir; the inbox resolves it through the `agentnetBindings` option, never `busRoot`. */
  const writeBindings = (peers: unknown[]) => {
    mkdirSync(agentnetDir(), { recursive: true, mode: 0o700 });
    writeFileSync(bindingsFile(), JSON.stringify({ version: 1, peers }), { mode: 0o600 });
    return bindingsFile();
  };
  const peerId = (n: number) => `peer-123e4567-e89b-42d3-a456-4266141740${String(n).padStart(2, '0')}`;
  const peerMessage = (id: string, to: string, text = 'ping') => ({ kind: 'peer.message',
    peer: { fromAgent: 'agent0', toAgent: to, kind: 'query', text, refs: [], threadId: id, origin: id, hopCount: 1 } });
  const peerEnvelope = (id: string, to: string, body: unknown = peerMessage(id, to), ttl = 86_400_000) =>
    ({ id, from: 'agent0', to, priority: 'P2', ttl, body });
  /** Post an envelope and return the stored original, its receipt stamp and the digest `sendPeerMessage` writes into the coordination ledger — the ledger admission proof's three parts. */
  const postPeerMail = (id: string, to: string, body?: unknown, at = now, ttl?: number) => {
    expect(appendBusInbox(peerEnvelope(id, to, body, ttl), { root: busRoot, now: () => at }).status).toBe('posted');
    const page = listBusInboxAfter(0, 100, { root: busRoot, now: () => now, includeOriginalEnvelope: true });
    const receipt = page.status === 'ok' ? page.messages.find(m => m.envelope.id === id) : undefined;
    const original = receipt?.originalEnvelope;
    if (receipt === undefined || original === undefined) throw new Error('fixture envelope missing');
    return { original, receivedAt: receipt.receivedAt,
      digest: createHash('sha256').update(JSON.stringify(original)).digest('hex') };
  };
  const writeLedger = (rows: unknown[]) => {
    const dir = join(busRoot, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'coordination.json'), JSON.stringify(rows), { mode: 0o600 });
  };
  const ledgerRow = (id: string, target: string, at: number, digest: string) => ({
    id, fromAgent: 'agent0', target, origin: id, digest, hopCount: 1, threadId: 'thread', at });
  const writeJournal = (receipts: unknown[]) => {
    const dir = join(busRoot, 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'work-dispatch.json'), JSON.stringify({ version: 1, receipts }), { mode: 0o600 });
  };

  it('lists only mail the admission proofs accept, naming the callsigns whose session admits it', async () => {
    // agent2's binding expired: nothing addressed to it can be read back now.
    const bindings = writeBindings([binding(1, now + 60_000), binding(2, now - 1), binding(3, now + 60_000)]);
    const admitted = postPeerMail(peerId(1), 'agent1');
    postPeerMail(peerId(2), 'agent2');
    postPeerMail(peerId(3), 'agent9');
    // Same peer shape but no ledger row: unproven mail never lists.
    postPeerMail(peerId(4), 'agent1');
    // Retained and live (48h TTL) but its ledger row is past the 24h admission
    // window — the send is too old for `peers read` to admit it back.
    const stale = postPeerMail(peerId(5), 'agent1', undefined, now - 25 * 3_600_000, 48 * 3_600_000);
    const forged = postPeerMail(peerId(6), 'agent1');
    writeLedger([
      ledgerRow(admitted.original.id, 'agent1', admitted.receivedAt, admitted.digest),
      // A second live callsign's row admits the same envelope — channel sends write one row per target.
      ledgerRow(admitted.original.id, 'agent3', admitted.receivedAt, admitted.digest),
      ledgerRow(peerId(2), 'agent2', now, 'a'.repeat(64)),
      ledgerRow(peerId(3), 'agent9', now, 'a'.repeat(64)),
      ledgerRow(stale.original.id, 'agent1', stale.receivedAt, stale.digest),
      // Right id, target and instant but a digest the stored body cannot match.
      ledgerRow(forged.original.id, 'agent1', forged.receivedAt, 'a'.repeat(64)),
    ]);
    const inbox = await read({ agentnetBindings: bindings });
    expect(inbox.sources['peer-inbox']).toEqual({ state: 'healthy', pending: 1 });
    const items = inbox.items.filter(i => i.source === 'peer-inbox');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `peer-inbox:${admitted.original.id}`, kind: 'peer-message',
      severity: 'warn', blocking: false,
      title: 'peer.message query agent0->agent1: ping',
      detail: 'admitted for agent1, agent3',
      since: new Date(admitted.receivedAt).toISOString(),
      expiresAt: new Date(admitted.receivedAt + 86_400_000).toISOString(),
      act: [
        `phm agentnet peers read --id ${admitted.original.id}`,
        `phm agents bus show ${admitted.original.id}`,
        'phm agentnet peers read',
      ],
    });
  });

  it('keeps feed-owned bodies under their own source and lists journal-proven work.result replies', async () => {
    const bindings = writeBindings([binding(1, now + 60_000)]);
    const message = postPeerMail(peerId(1), 'agent1');
    // Claimable work and a work.post announcement are admitted too, but the
    // bus source already owns those pending things — one pending thing one item.
    const claimable = postPeerMail(peerId(7), 'agent1', { kind: 'work', text: 'fake claimable' });
    const announced = postPeerMail(peerId(8), 'agent1', { kind: 'work.post', jobId: 'RQ-ANNOUNCED',
      title: 'fake announced job', provider: 'codex-cmp', repo: 'ashlrai/phantom', claimKeys: ['queue:RQ-ANNOUNCED'] });
    // A published work.result reply the feed never lists as an item: the
    // journal's sent outcome is the admission proof.
    const receiptId = `pw-${'a'.repeat(32)}`;
    const resultBody = { kind: 'work.result', jobId: 'RQ-PEER-1', claimKey: 'repo:ashlrai/phantom',
      queueId: `peer-work-${'b'.repeat(32)}`, receiptId, outcome: 'complete' };
    const result = postPeerMail(`${receiptId}-complete`, 'agent1', resultBody);
    writeJournal([{ ...resultBody, peer: 'agent1', consumer: 'agent0',
      digest: 'c'.repeat(64), at: result.receivedAt, sent: 'complete', outcome: 'complete' }]);
    writeLedger([
      ledgerRow(message.original.id, 'agent1', message.receivedAt, message.digest),
      ledgerRow(claimable.original.id, 'agent1', claimable.receivedAt, claimable.digest),
      ledgerRow(announced.original.id, 'agent1', announced.receivedAt, announced.digest),
    ]);
    const inbox = await read({ agentnetBindings: bindings });
    expect(inbox.sources['peer-inbox']).toEqual({ state: 'healthy', pending: 2 });
    const byId = new Map(inbox.items.filter(i => i.source === 'peer-inbox').map(i => [i.id, i]));
    expect([...byId.keys()].sort()).toEqual([`peer-inbox:${message.original.id}`, `peer-inbox:${result.original.id}`].sort());
    expect(byId.get(`peer-inbox:${result.original.id}`)).toMatchObject({
      kind: 'peer-message', severity: 'warn', blocking: false,
      title: 'work.result RQ-PEER-1: complete', jobIds: ['RQ-PEER-1'],
      detail: 'admitted for agent1',
    });
    // The excluded bodies still surface under their owning sources instead.
    expect(inbox.items.some(i => i.source === 'bus' && i.id.includes(claimable.original.id))).toBe(true);
  });

  it('reports missing and unreadable admission inputs honestly, never a fabricated empty', async () => {
    // No bindings file at all: no peer can hold admitted mail — verified missing.
    const missing = await read();
    expect(missing.sources['peer-inbox']).toEqual({ state: 'missing', pending: 0 });

    // Live callsign but no bus store: still verified missing.
    const noStore = await read({ agentnetBindings: writeBindings([binding(1, now + 60_000)]) });
    expect(noStore.sources['peer-inbox']).toEqual({ state: 'missing', pending: 0 });

    // Live callsign, retained mail, corrupt ledger: the read cannot prove
    // anything — unavailable with a null pending, never a ledger-only undercount.
    const bindings = writeBindings([binding(1, now + 60_000)]);
    postPeerMail(peerId(1), 'agent1');
    mkdirSync(join(busRoot, 'agentnet'), { recursive: true, mode: 0o700 });
    writeFileSync(join(busRoot, 'agentnet', 'coordination.json'), '{not json', { mode: 0o600 });
    const degraded = await read({ agentnetBindings: bindings });
    expect(degraded.sources['peer-inbox']).toEqual({ state: 'unavailable', pending: null });
    expect(degraded.items.filter(i => i.source === 'peer-inbox')).toHaveLength(0);

    // Corrupt bindings refuse every peer verb — and this read — the same way.
    writeFileSync(bindingsFile(), '{not json', { mode: 0o600 });
    const corruptBindings = await read({ agentnetBindings: bindings });
    expect(corruptBindings.sources['peer-inbox']).toEqual({ state: 'unavailable', pending: null });

    // A throwing seam reports unavailable while other sources still list.
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    const throwing = await read({ agentnetBindings: bindings,
      readPeerInbox: () => { throw new Error('boom'); } });
    expect(throwing.sources['peer-inbox']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'needs-you')).toHaveLength(1);

    // Seam states map through unchanged; a truncated scan degrades.
    const seam = (state: 'missing' | 'available' | 'unavailable', truncated = false) =>
      read({ agentnetBindings: bindings, readPeerInbox: () => ({ state, messages: [], truncated }) });
    expect((await seam('missing')).sources['peer-inbox']).toEqual({ state: 'missing', pending: 0 });
    expect((await seam('unavailable')).sources['peer-inbox']).toEqual({ state: 'unavailable', pending: null });
    expect((await seam('available', true)).sources['peer-inbox']).toEqual({ state: 'degraded', pending: 0 });
    expect((await seam('available')).sources['peer-inbox']).toEqual({ state: 'healthy', pending: 0 });
  });

  it('filters by source, kind, job citation and contains like every other source', async () => {
    const bindings = writeBindings([binding(1, now + 60_000)]);
    const message = postPeerMail(peerId(1), 'agent1');
    const receiptId = `pw-${'c'.repeat(32)}`;
    const resultBody = { kind: 'work.result', jobId: 'RQ-FILTER', claimKey: 'repo:ashlrai/phantom',
      queueId: `peer-work-${'d'.repeat(32)}`, receiptId, outcome: 'failed', reason: 'repo-denied' };
    const result = postPeerMail(`${receiptId}-failed`, 'agent1', resultBody);
    writeJournal([{ ...resultBody, peer: 'agent1', consumer: 'agent0',
      digest: 'e'.repeat(64), at: result.receivedAt, sent: 'failed', outcome: 'failed' }]);
    writeLedger([ledgerRow(message.original.id, 'agent1', message.receivedAt, message.digest)]);
    const readPeer = (filter: UnifiedInboxOptions['filter']) =>
      read({ agentnetBindings: bindings, filter });

    const bySource = await readPeer({ source: 'peer-inbox' });
    expect(bySource.total).toBe(2);
    expect(bySource.items.every(i => i.source === 'peer-inbox' && i.kind === 'peer-message')).toBe(true);

    const byKind = await readPeer({ kind: 'peer-message', source: 'peer-inbox' });
    expect(byKind.total).toBe(2);

    const byJob = await readPeer({ job: 'RQ-FILTER' });
    const peerJobItems = byJob.items.filter(i => i.source === 'peer-inbox');
    expect(peerJobItems.map(i => i.id)).toEqual([`peer-inbox:${result.original.id}`]);
    expect(peerJobItems[0]!.jobIds).toEqual(['RQ-FILTER']);

    const byText = await readPeer({ contains: 'peer.message query' });
    expect(byText.items.filter(i => i.source === 'peer-inbox').map(i => i.id))
      .toEqual([`peer-inbox:${message.original.id}`]);
    const byOutcome = await readPeer({ contains: 'work.result RQ-FILTER' });
    expect(byOutcome.items.filter(i => i.source === 'peer-inbox').map(i => i.id))
      .toEqual([`peer-inbox:${result.original.id}`]);
  });
});

describe('readUnifiedInbox session handoffs', () => {
  const AT = '2026-11-07T11:00:00.000Z';
  /** A schema-valid `session-handoff.v1` record — the same shape session-handoff-list.test.ts writes. */
  const record = (job: string, over: Record<string, unknown> = {}) => ({
    schema: 'session-handoff.v1', revision: 1, at: AT,
    signal: { kind: 'checkpoint' },
    job, attempt: 'att-1', repo: 'test/fixture', lane: 'codex-personal', model: 'model-a',
    minTier: 'work', needs: ['typescript'], goal: 'Do the fake thing',
    plan: [{ action: 'step 1', state: 'pending' }], filesTouched: ['result'],
    decisions: ['keep it'], evidence: ['e1'], nextAction: 'do step 1', contextDigest: 'ctx',
    repoState: { root: '/fake/host/root', head: 'a'.repeat(40), digest: 'b'.repeat(64), entireCheckpoint: null },
    ...over,
  });
  /** `<runsDir>/handoffs/<job>.jsonl` — the default reader's real path, private modes like the writer's. */
  const writeJournal = (job: string, records: object[]) => {
    const dir = join(runsDir, 'handoffs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${job}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  };
  const entry = (over: Partial<SessionHandoffListEntry> = {}): SessionHandoffListEntry => ({
    job: 'RQ-SESS-1', attempt: 'att-1', revision: 1, at: AT,
    lane: 'codex-personal', model: 'model-a', minTier: 'work', repo: 'test/fixture',
    signal: { kind: 'checkpoint' }, needs: ['typescript'], state: 'open', head: 'a'.repeat(40),
    ...over,
  });
  const list = (over: Partial<SessionHandoffList> = {}): SessionHandoffList => ({
    schema: 'session-handoff.list.v1', status: 'ok',
    handoffs: [entry()], unreadable: [], truncated: false, ...over,
  });

  it('lists open checkpoints from real journals with their resume facts', async () => {
    writeJournal('RQ-SESS-1', [record('RQ-SESS-1', { signal: { kind: 'rate-limit', status: 429 } })]);
    writeJournal('RQ-SESS-2', [
      record('RQ-SESS-2', { revision: 1, at: '2026-11-07T10:00:00.000Z' }),
      record('RQ-SESS-2', { revision: 2, at: '2026-11-07T10:30:00.000Z' }),
    ]);
    // A completed journal is retained history, never pending work.
    writeJournal('RQ-SESS-3', [
      record('RQ-SESS-3', { revision: 1 }),
      record('RQ-SESS-3', { revision: 2, signal: { kind: 'completed' },
        plan: [{ action: 'step 1', state: 'done' }] }),
    ]);
    const inbox = await read();
    expect(inbox.sources['session-handoff']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'session-handoff');
    expect(items).toHaveLength(2);
    const byId = new Map(items.map(i => [i.id, i]));
    const failover = byId.get('session-handoff:RQ-SESS-1')!;
    expect(failover).toMatchObject({
      kind: 'session-handoff', severity: 'warn', blocking: false,
      title: 'Session handoff RQ-SESS-1: rate-limit (failover)',
      since: AT, expiresAt: '2026-11-08T11:00:00.000Z', jobIds: ['RQ-SESS-1'],
    });
    expect(failover.detail).toContain('codex-personal');
    expect(failover.detail).toContain('model-a');
    expect(failover.detail).toContain('test/fixture');
    expect(failover.detail).toContain('attempt att-1 rev 1');
    expect(failover.detail).toContain('typescript');
    expect(failover.act[0]).toBe(`phm checkpoint handoff show ${runsDir} RQ-SESS-1`);
    expect(failover.act[1]).toBe(`phm checkpoint handoff list ${runsDir} --state open`);
    // The plain checkpoint lists without the failover marker; its `since`
    // is the latest revision's time, not the first.
    expect(byId.get('session-handoff:RQ-SESS-2')).toMatchObject({
      title: 'Session handoff RQ-SESS-2: checkpoint',
      since: '2026-11-07T10:30:00.000Z', expiresAt: '2026-11-08T10:30:00.000Z',
    });
    expect(byId.has('session-handoff:RQ-SESS-3')).toBe(false);
  });

  it('reports missing, degraded and unavailable honestly, never an empty pass-off', async () => {
    const missing = await read();
    expect(missing.sources['session-handoff']).toEqual({ state: 'missing', pending: 0 });

    // A corrupt journal degrades the source but the readable one still lists.
    writeJournal('RQ-SESS-1', [record('RQ-SESS-1')]);
    const dir = join(runsDir, 'handoffs');
    writeFileSync(join(dir, 'RQ-BAD.jsonl'), 'not json at all\n', { mode: 0o600 });
    const degraded = await read();
    expect(degraded.sources['session-handoff']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'session-handoff')).toHaveLength(1);

    const throwing = await read({
      readSessionHandoffs: () => { throw new Error('boom'); },
    });
    expect(throwing.sources['session-handoff']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'session-handoff')).toHaveLength(0);

    const unavailable = await read({ readSessionHandoffs: () => ({ ...list(), status: 'unavailable' as const, handoffs: null, unreadable: null }) });
    expect(unavailable.sources['session-handoff']).toEqual({ state: 'unavailable', pending: null });
  });

  it('degrades on a truncated scan and on seam entries outside the open state', async () => {
    const truncated = await read({ readSessionHandoffs: () => ({ ...list(), truncated: true }) });
    expect(truncated.sources['session-handoff']).toEqual({ state: 'degraded', pending: 1 });

    const mixed = await read({
      readSessionHandoffs: () => list({ handoffs: [
        entry(),
        entry({ job: 'RQ-SESS-DONE', state: 'completed', signal: { kind: 'completed' } }),
      ] }),
    });
    expect(mixed.sources['session-handoff']).toEqual({ state: 'healthy', pending: 1 });
    expect(mixed.items.filter(i => i.source === 'session-handoff').map(i => i.id)).toEqual(['session-handoff:RQ-SESS-1']);
  });

  it('filters by source, kind, job citation, time window and contains like every other source', async () => {
    writeJournal('RQ-SESS-1', [record('RQ-SESS-1', { signal: { kind: 'rate-limit', status: 429 } })]);
    writeJournal('RQ-SESS-2', [record('RQ-SESS-2', { at: '2026-11-07T09:00:00.000Z' })]);
    const inbox = await read({ filter: { source: 'session-handoff' } });
    expect(inbox.total).toBe(2);
    expect(inbox.items.every(i => i.source === 'session-handoff' && i.kind === 'session-handoff')).toBe(true);
    expect(inbox.sources['session-handoff']).toEqual({ state: 'healthy', pending: 2 });

    const byJob = await read({ filter: { job: 'RQ-SESS-1' } });
    expect(byJob.items.map(i => i.id)).toEqual(['session-handoff:RQ-SESS-1']);

    const byKind = await read({ filter: { kind: 'session-handoff' } });
    expect(byKind.total).toBe(2);

    const bySince = await read({ filter: { since: Date.parse('2026-11-07T10:00:00.000Z') } });
    expect(bySince.items.map(i => i.id)).toEqual(['session-handoff:RQ-SESS-1']);
    const byBefore = await read({ filter: { before: Date.parse('2026-11-07T10:00:00.000Z') } });
    expect(byBefore.items.map(i => i.id)).toEqual(['session-handoff:RQ-SESS-2']);

    const byLane = await read({ filter: { contains: 'codex-personal' } });
    expect(byLane.items.map(i => i.id).sort()).toEqual(['session-handoff:RQ-SESS-1', 'session-handoff:RQ-SESS-2']);
    const byFailover = await read({ filter: { contains: 'failover' } });
    expect(byFailover.items.map(i => i.id)).toEqual(['session-handoff:RQ-SESS-1']);
  });
});

describe('readUnifiedInbox org outbox', () => {
  const STORE_ID = '123e4567-e89b-42d3-a456-426614174000';
  const role = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `fake role ${id}`, charter: 'fake charter',
    tier: 'WORKER_SESSION', reportsTo: 'orch', status: 'active', scope: 'engineering',
    needs: [], laneAffinities: [],
    budget: { tokens: 100, sessions: 2, maxCostClass: 'local' },
    sizing: { batchDepth: 10, fanOut: 2 },
    sessionId: null, ...over,
  });
  // A chart `validateChart` accepts: one active leader, one orchestrator
  // under it, workers under the orchestrator inside its budget ceiling.
  const agents = [
    role('leader', { tier: 'LEADER', reportsTo: null, budget: { tokens: 1000, sessions: 10, maxCostClass: 'local' }, sizing: { batchDepth: 10, fanOut: 8 } }),
    role('orch', { tier: 'ORCHESTRATOR', reportsTo: 'leader', budget: { tokens: 500, sessions: 5, maxCostClass: 'local' }, sizing: { batchDepth: 10, fanOut: 4 } }),
  ];
  const entry = (revision: number, edits: unknown[], over: Record<string, unknown> = {}) => ({
    revision, at: `2026-11-07T10:0${revision}:00.000Z`,
    proposal: { actor: 'leader', reason: 'fake reason', expectedRevision: revision - 1,
      change: { kind: 'upsert', role: role(`worker-${revision}`) } },
    applied: true, edits, busDelivered: false, ...over,
  });
  const plane = (ledger: unknown[], over: Record<string, unknown> = {}) => ({
    schema: 'org.agents.v1', storeId: STORE_ID, revision: ledger.length,
    agents, ledger, ...over,
  });
  /** The store `readAgentPlane` reads — `<runsDir>/org/agents.json`, private-file gated. */
  const writePlane = (value: unknown) => {
    const dir = join(runsDir, 'org');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'agents.json'), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  };

  it('lists ledger edits the bus never received and keeps delivered ones out', async () => {
    writePlane(plane([
      // Delivered — history, not pending.
      entry(1, [{ before: null, after: role('worker-1') }], { busDelivered: true }),
      // Undelivered upsert — one pending org.membership event.
      entry(2, [{ before: null, after: role('worker-2') }]),
      // Undelivered retire edit — after null means status retired, role is the before row.
      entry(3, [{ before: role('worker-3'), after: null }], {
        proposal: { actor: 'leader', reason: 'fake reason', expectedRevision: 2, change: { kind: 'retire', id: 'worker-3' } },
      }),
    ]));
    const inbox = await read();
    expect(inbox.sources['org-outbox']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'org-outbox');
    expect(items).toHaveLength(2);
    const byId = new Map(items.map(i => [i.id, i]));
    expect(byId.get(`org-outbox:org-${STORE_ID}-2-worker-2`)).toMatchObject({
      kind: 'org-membership', severity: 'warn', blocking: false,
      title: 'org role worker-2 (WORKER_SESSION active) awaits bus delivery',
      detail: `rev 2 · proposed by leader · event org-${STORE_ID}-2-worker-2`,
      since: '2026-11-07T10:02:00.000Z', expiresAt: null,
      act: ['phm fleet org-sync --apply', 'phm fleet org-board'],
    });
    expect(byId.get(`org-outbox:org-${STORE_ID}-3-worker-3`)).toMatchObject({
      title: 'org role worker-3 (WORKER_SESSION retired) awaits bus delivery',
      detail: `rev 3 · proposed by leader · event org-${STORE_ID}-3-worker-3`,
      since: '2026-11-07T10:03:00.000Z',
    });
    // Ledger fields are callsigns, role ids and revisions — never charters or reasons.
    expect(JSON.stringify(items)).not.toContain('fake charter');
    expect(JSON.stringify(items)).not.toContain('fake reason');
  });

  it('keeps one item per (revision, role) event id even if edits repeat a role', async () => {
    writePlane(plane([
      entry(1, [
        { before: null, after: role('worker-1') },
        { before: role('worker-1'), after: role('worker-1', { status: 'retired' }) },
      ]),
      // Same role in a later revision is a different stable event id — still pending.
      entry(2, [{ before: role('worker-1', { status: 'retired' }), after: null }], {
        proposal: { actor: 'leader', reason: 'fake reason', expectedRevision: 1, change: { kind: 'retire', id: 'worker-1' } },
      }),
    ]));
    const inbox = await read();
    expect(inbox.sources['org-outbox']).toEqual({ state: 'healthy', pending: 2 });
    expect(inbox.items.filter(i => i.source === 'org-outbox').map(i => i.id).sort())
      .toEqual([`org-outbox:org-${STORE_ID}-1-worker-1`, `org-outbox:org-${STORE_ID}-2-worker-1`]);
  });

  it('reports the store state honestly: missing, unreadable, invalid, throwing seam', async () => {
    const missing = await read();
    expect(missing.sources['org-outbox']).toEqual({ state: 'missing', pending: 0 });

    writePlane('{not json');
    const degraded = await read();
    expect(degraded.sources['org-outbox']).toEqual({ state: 'unavailable', pending: null });
    expect(degraded.items.filter(i => i.source === 'org-outbox')).toHaveLength(0);

    // A chart validateChart refuses — a second leader — is unavailable, never a partial backlog.
    writePlane(plane([entry(1, [{ before: null, after: role('worker-1') }])], {
      agents: [...agents, role('leader2', { tier: 'LEADER', reportsTo: null })],
    }));
    const badChart = await read();
    expect(badChart.sources['org-outbox']).toEqual({ state: 'unavailable', pending: null });

    // A non-contiguous ledger is refused exactly like readAgentPlane refuses it.
    writePlane(plane([entry(2, [{ before: null, after: role('worker-2') }])]));
    const badLedger = await read();
    expect(badLedger.sources['org-outbox']).toEqual({ state: 'unavailable', pending: null });

    // An undelivered edit with neither before nor after is one envelopes() cannot
    // form — the apply pass would crash on it, so the read reports unavailable.
    writePlane(plane([entry(1, [{ before: null, after: null }])]));
    const noRole = await read();
    expect(noRole.sources['org-outbox']).toEqual({ state: 'unavailable', pending: null });

    // Secret-shaped content anywhere in the store trips the same assertMetadata gate.
    writePlane(plane([entry(1, [{ before: null, after: role('worker-1') }])], {
      agents: agents.map(a => a.id === 'orch' ? { ...a, charter: 'token sk-ant-api03-' + 'x'.repeat(30) } : a),
    }));
    const secret = await read();
    expect(secret.sources['org-outbox']).toEqual({ state: 'unavailable', pending: null });

    rmSync(join(runsDir, 'org', 'agents.json'));
    const throwing = await read({
      readOrgOutbox: () => { throw new Error('boom'); },
    });
    expect(throwing.sources['org-outbox']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'org-outbox')).toHaveLength(0);
  });

  it('filters by source, kind, contains and never matches --job (no job citation)', async () => {
    writePlane(plane([
      entry(1, [{ before: null, after: role('worker-1') }]),
      entry(2, [{ before: null, after: role('worker-2') }]),
    ]));
    const bySource = await read({ filter: { source: 'org-outbox' } });
    expect(bySource.total).toBe(2);
    expect(bySource.items.every(i => i.source === 'org-outbox' && i.kind === 'org-membership')).toBe(true);
    expect(bySource.sources['org-outbox']).toEqual({ state: 'healthy', pending: 2 });

    const byKind = await read({ filter: { kind: 'org-membership', source: 'org-outbox' } });
    expect(byKind.total).toBe(2);

    const byText = await read({ filter: { contains: 'worker-2' } });
    expect(byText.items.map(i => i.id)).toEqual([`org-outbox:org-${STORE_ID}-2-worker-2`]);

    // Org events name no job — a --job filter never pulls one in.
    const byJob = await read({ filter: { job: 'RQ-ANYTHING' } });
    expect(byJob.items.filter(i => i.source === 'org-outbox')).toHaveLength(0);
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

describe('coordination work board in the unified inbox', () => {
  const boardItem = (id: string, state: WorkItemState, over: Partial<WorkBoardItem> = {}): WorkBoardItem => ({
    id, channel: 'bus', channelRef: null,
    receivedAt: new Date(now - 60_000).toISOString(),
    state, asOf: new Date(now).toISOString(), source: 'bus',
    missing: [], owner: null, claimReceipt: null,
    ...over,
  });
  const boardResult = (items: WorkBoardItem[], over: Partial<WorkBoardResult> = {}): WorkBoardResult => ({
    items, inbox: 'ok', truncated: false, claims: 'available', coordination: 'available',
    ...over,
  });
  const readBoard = (result: WorkBoardResult, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readWorkBoard: () => result, ...extra });

  it('lists RECEIVED, ASSIGNED and BLOCKED requests with their classification, never RUNNING or VERIFIED', async () => {
    const inbox = await readBoard(boardResult([
      boardItem('env-received', 'RECEIVED', { missing: ['named owner', 'durable claim receipt'] }),
      boardItem('env-assigned', 'ASSIGNED', {
        owner: 'agent:peer', claimReceipt: 'bus-claim:env-assigned:4:1762619940000',
        missing: ['fresh running evidence'], channelRef: 'team/ch/123.456',
      }),
      boardItem('env-blocked', 'BLOCKED', {
        owner: 'agent:peer', claimReceipt: 'bus-claim:env-blocked:2:1762619940000',
        result: { kind: 'blocked', dependency: 'env-dep' },
      }),
      boardItem('env-running', 'RUNNING', { owner: 'agent:peer', claimReceipt: 'bus-claim:env-running:1:x' }),
      boardItem('env-verified', 'VERIFIED', { result: { kind: 'verified', pr: 12, head: 'abc', tests: null, artifact: null } }),
    ]));
    expect(inbox.sources['work-board']).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'work-board');
    expect(items.map(i => i.id).sort()).toEqual(['work-board:env-assigned', 'work-board:env-blocked', 'work-board:env-received']);

    const received = items.find(i => i.id === 'work-board:env-received')!;
    expect(received).toMatchObject({
      kind: 'work-board-received', severity: 'warn', blocking: false,
      title: 'Work board · RECEIVED · env-received',
      since: new Date(now - 60_000).toISOString(), expiresAt: null,
      act: ['phm fleet work-board --state RECEIVED', 'phm fleet work-trace --id env-received'],
    });
    expect(received.detail).toContain('unclaimed request');
    expect(received.detail).toContain('missing named owner, durable claim receipt');
    expect(received.jobIds).toBeUndefined();

    const assigned = items.find(i => i.id === 'work-board:env-assigned')!;
    expect(assigned).toMatchObject({ kind: 'work-board-assigned', severity: 'info', blocking: false });
    expect(assigned.detail).toContain('assigned');
    expect(assigned.detail).toContain('agent:peer');
    expect(assigned.detail).toContain('team/ch/123.456');

    const blocked = items.find(i => i.id === 'work-board:env-blocked')!;
    expect(blocked).toMatchObject({ kind: 'work-board-blocked', severity: 'warn', blocking: false });
    expect(blocked.detail).toContain('blocked');
    expect(blocked.detail).toContain('waiting on env-dep');
  });

  it('leaves envelopes the bus source already represents under bus — one pending thing, one item', async () => {
    postWork('wb-claimable');                    // a claimable work body → bus: item → covered.envelopes
    const feedEnv = postJob('job-feed');         // a work.post announcement → covered.posts
    const inbox = await readBoard(boardResult([
      boardItem('wb-claimable', 'RECEIVED', { missing: ['named owner'] }),
      boardItem(feedEnv, 'RECEIVED', { missing: ['named owner'] }),
      boardItem('wb-unique', 'RECEIVED', { missing: ['named owner'] }),
    ]));
    const wb = inbox.items.filter(i => i.source === 'work-board');
    expect(wb.map(i => i.id)).toEqual(['work-board:wb-unique']);
    // Both covered envelopes still surface once, under the bus source.
    expect(inbox.items.filter(i => i.id === 'bus:wb-claimable')).toHaveLength(1);
    expect(inbox.items.some(i => i.id === 'bus-feed:job-feed')).toBe(true);
  });

  it('reports an unreadable board scan unavailable and partial evidence degraded', async () => {
    const unavailable = await read({ readWorkBoard: () => ({ items: [], inbox: 'unavailable', truncated: false }) });
    expect(unavailable.sources['work-board']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'work-board')).toHaveLength(0);

    const throwing = await read({ readWorkBoard: () => { throw new Error('board boom'); } });
    expect(throwing.sources['work-board']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'work-board')).toHaveLength(0);

    for (const over of [
      { truncated: true },
      { claims: 'unavailable' as const },
      { coordination: 'unavailable' as const },
    ]) {
      const degraded = await readBoard(boardResult([boardItem('env-1', 'RECEIVED', { missing: ['named owner'] })], over));
      expect(degraded.sources['work-board']).toEqual({ state: 'degraded', pending: 1 });
      expect(degraded.items.filter(i => i.source === 'work-board')).toHaveLength(1);
    }
  });

  it('narrows under --source and --kind like every other source, and never matches --job', async () => {
    const pending = boardResult([
      boardItem('env-received', 'RECEIVED', { missing: ['named owner', 'durable claim receipt'] }),
      boardItem('env-blocked', 'BLOCKED', { result: { kind: 'blocked', dependency: 'env-dep' } }),
    ]);
    const bySource = await readBoard(pending, { filter: { source: 'work-board' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'work-board')).toBe(true);
    const byKind = await readBoard(pending, { filter: { kind: 'work-board-received' } });
    expect(byKind.items.map(i => i.id)).toEqual(['work-board:env-received']);
    expect(byKind.sources['work-board']).toEqual({ state: 'healthy', pending: 2 });
    // A board item provably names no job — --job never matches it.
    const byJob = await readBoard(pending, { filter: { job: 'job-1' } });
    expect(byJob.items.filter(i => i.source === 'work-board')).toHaveLength(0);
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
    seatId: 'devin-review', participantId: 'devin-review', state: 'draining', eligible: true,
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
    expect(lines().at(-1)).toContain('phm comms inbox [--source <name>] [--kind <name>] [--severity <info|warn|high>] [--blocking] [--job <id>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--limit <1..200>] [--json]');
    for (const args of [['--json', '--json'], ['unified'], ['--limit', '0'], ['bogus', '--json']]) {
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

  it('pages the unified view with --limit', async () => {
    const { command, json, lines } = setupCli();
    postWork('cli-limit-1', { priority: 'P0' });
    postWork('cli-limit-2');
    postWork('cli-limit-3');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    // --limit keeps the first N ranked items of the matched view — the same
    // slice GET /api/verse/comms/inbox and fleet_comms_inbox apply; total
    // stays the true matched count and omitted covers every unshown item.
    expect(await command(['--limit', '2', '--json'])).toBe(0);
    let report = json();
    expect(report.total).toBe(4);
    expect(report.items).toHaveLength(2);
    expect(report.omitted).toBe(2);
    // The per-source counts stay the unfiltered store truth.
    expect(report.sources.bus.pending).toBe(3);
    expect(report.sources['needs-you'].pending).toBe(1);

    // --limit ANDs with the view filters and never widens them.
    expect(await command(['--source', 'bus', '--limit', '1', '--json'])).toBe(0);
    report = json();
    expect(report.filter).toEqual({ source: 'bus' });
    expect(report.total).toBe(3);
    expect(report.items).toHaveLength(1);
    expect(report.omitted).toBe(2);
    expect(report.items[0]!.source).toBe('bus');

    // A bound at or beyond the matched count changes nothing.
    expect(await command(['--limit', '200', '--json'])).toBe(0);
    report = json();
    expect(report.items).toHaveLength(4);
    expect(report.omitted).toBe(0);

    // The human view prints the same page and counts the unshown tail.
    expect(await command(['--limit', '1'])).toBe(0);
    const footer = lines().at(-1)!;
    expect(footer).toContain('4 pending');
    expect(footer).toContain('3 omitted');
  });

  it('counts both the item cap and --limit in omitted', async () => {
    const { command, json } = setupCli();
    postWorkSnapshot(Array.from({ length: 250 }, (_, i) => `cli-cap-${i}`));
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');

    // Without --limit the report already caps items at 200 and counts the
    // rest in omitted; --limit slices that page further and omitted covers
    // every item still unshown, never a fabricated zero.
    expect(await command(['--json'])).toBe(0);
    let report = json();
    expect(report.total).toBe(251);
    expect(report.items).toHaveLength(200);
    expect(report.omitted).toBe(51);

    expect(await command(['--limit', '10', '--json'])).toBe(0);
    report = json();
    expect(report.total).toBe(251);
    expect(report.items).toHaveLength(10);
    expect(report.omitted).toBe(241);
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
      ['--limit'], ['--limit', '--json'], ['--json', '--limit'],
      ['--limit', '0'], ['--limit', '201'], ['--limit', '1.5'], ['--limit', '-3'],
      ['--limit', 'x'.repeat(40)], ['--limit', '2', '--limit', '3'],
      ['--limit', '5', '--source'], ['--source', 'bus', '--limit'],
    ]) {
      expect(await command(args), args.join(' ')).toBe(2);
      expect(JSON.parse(lines().at(-1)!)).toEqual({ status: 'invalid' });
    }
  });
});

describe('readUnifiedInbox coordination', () => {
  const coordMessage = (over: Partial<FleetMessage> = {}): FleetMessage => ({
    id: 'm-1', from: 'agent-a', to: 'agent-b', body: 'fake coordination mail',
    at: now - 60_000, expiresAt: now + 3_600_000, ...over,
  });
  const coordProposal = (over: Partial<FleetAssignment> = {}): FleetAssignment => ({
    id: 'p-1', repo: 'ashlrai/phantom', task: 'fake assignment', to: 'agent-c',
    at: now - 120_000, expiresAt: now + 3_600_000, executionAuthorized: false, ...over,
  });
  const coordReturn = (over: Partial<FleetPendingReturn> = {}): FleetPendingReturn => ({
    id: 'claim-1', agent: 'agent-d', at: now - 180_000,
    message: {
      id: 'return-claim-1', from: 'agent-d', to: 'all',
      body: 'RESULT VERIFIED ashlrai/phantom claim claim-1 task "fake": tests passed',
      at: now - 180_000, expiresAt: now + 86_400_000,
    },
    ...over,
  });
  const coordPending = (over: Partial<FleetCoordinationPending> = {}): FleetCoordinationPending => ({
    schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], returns: [], ...over,
  });
  const readCoord = (pending: FleetCoordinationPending, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readFleetCoordination: () => pending, ...extra });

  it('lists live messages, assignments and unposted returns with their own stamps and acts', async () => {
    const inbox = await readCoord(coordPending({
      messages: [coordMessage(), coordMessage({ id: 'm-2', to: 'all', body: 'fake broadcast' })],
      proposals: [coordProposal()],
      returns: [coordReturn()],
    }));
    expect(inbox.sources.coordination).toEqual({ state: 'healthy', pending: 4 });
    const items = inbox.items.filter(i => i.source === 'coordination');
    expect(items).toHaveLength(4);

    const dm = items.find(i => i.id === 'coordination:message-m-1')!;
    expect(dm).toMatchObject({
      kind: 'coordination-message', severity: 'info', blocking: false,
      title: 'fake coordination mail',
      since: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    });
    expect(dm.detail).toContain('from agent-a');
    expect(dm.detail).toContain('to agent-b');
    expect(dm.act).toEqual(['phm fleet coordination inbox --agent agent-b --json']);

    const bcast = items.find(i => i.id === 'coordination:message-m-2')!;
    expect(bcast.title).toBe('fake broadcast');
    expect(bcast.act).toEqual(['phm fleet coordination board --json']);

    const asg = items.find(i => i.id === 'coordination:assignment-p-1')!;
    expect(asg).toMatchObject({
      kind: 'coordination-assignment', severity: 'info', blocking: false, title: 'fake assignment',
      since: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    });
    expect(asg.detail).toContain('advisory');
    expect(asg.detail).toContain('ashlrai/phantom');
    expect(asg.detail).toContain('to agent-c');
    expect(asg.act).toEqual(['phm fleet coordination inbox --agent agent-c --json']);

    const ret = items.find(i => i.id === 'coordination:return-claim-1')!;
    expect(ret).toMatchObject({
      kind: 'coordination-return-unposted', severity: 'warn', blocking: false,
      title: 'Unposted coordination RESULT · claim claim-1',
      since: new Date(now - 180_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
    });
    expect(ret.detail).toContain('agent-d');
    expect(ret.detail).toContain('receipt publish never landed');
    expect(ret.detail).toContain('coordination return claim-1');
    expect(ret.act).toEqual(['phm fleet coordination board --json']);
  });

  it('reports missing, unknown and throwing reads honestly — never an invented backlog', async () => {
    const missing = await readCoord(coordPending({ state: 'missing' }));
    expect(missing.sources.coordination).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'coordination')).toHaveLength(0);

    const unknown = await readCoord(coordPending({ state: 'unknown' }));
    expect(unknown.sources.coordination).toEqual({ state: 'unavailable', pending: null });
    expect(unknown.items.filter(i => i.source === 'coordination')).toHaveLength(0);

    const throwing = await read({
      readFleetCoordination: () => { throw new Error('ledger boom'); },
    });
    expect(throwing.sources.coordination).toEqual({ state: 'unavailable', pending: null });
  });

  it('narrows under --source and --kind like every other source', async () => {
    const pending = coordPending({ messages: [coordMessage()], returns: [coordReturn()] });
    const bySource = await readCoord(pending, { filter: { source: 'coordination' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'coordination')).toBe(true);
    const byKind = await readCoord(pending, { filter: { kind: 'coordination-return-unposted' } });
    expect(byKind.items.map(i => i.id)).toEqual(['coordination:return-claim-1']);
    expect(byKind.sources.coordination).toEqual({ state: 'healthy', pending: 2 });
  });
});

describe('readUnifiedInbox claim drift', () => {
  const driftRow = (over: Partial<ClaimDriftRow> = {}): ClaimDriftRow => ({
    id: 'env-1', cursor: 7,
    receivedAt: new Date(now - 60_000).toISOString(),
    owner: 'agent:peer', leaseUntil: new Date(now + 600_000).toISOString(),
    ...over,
  });
  const drift = (over: Partial<ClaimStoreDrift> = {}): ClaimStoreDrift => ({
    schema: 'fleet.claim-drift.v1', asOf: new Date(now).toISOString(),
    bus: 'available', coordination: 'available', matched: 3,
    busOnly: [], coordOnly: [], ownerMismatch: [], state: 'VERIFIED', missing: [],
    ...over,
  });
  const readDrift = (d: ClaimStoreDrift, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readClaimDrift: () => d, ...extra });

  it('lists each drift row class as a warn with its own kind, stamps and acts', async () => {
    const inbox = await readDrift(drift({
      state: 'DRIFT',
      busOnly: [driftRow({ id: 'env-bus', cursor: 3, owner: 'agent:bus-owner' })],
      coordOnly: [driftRow({
        id: 'env-coord', cursor: 9, owner: 'agent:coord-owner',
        sourceId: 'env-coord:9:1762619940000',
      })],
      ownerMismatch: [driftRow({
        id: 'env-owner', cursor: 5, owner: 'agent:bus-side',
        busOwner: 'agent:bus-side', coordOwner: 'agent:coord-side',
      })],
    }));
    expect(inbox.sources['claim-drift']).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'claim-drift');
    expect(items).toHaveLength(3);

    const busOnly = items.find(i => i.id.startsWith('claim-drift:bus:env-bus:3:'))!;
    expect(busOnly).toMatchObject({
      kind: 'claim-drift-bus', severity: 'warn', blocking: false,
      title: 'Claim drift · bus-only lease on env-bus',
      since: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
    });
    expect(busOnly.id).toContain('env-bus:3:');
    expect(busOnly.detail).toContain('bus claims table');
    expect(busOnly.detail).toContain('agent:bus-owner');
    expect(busOnly.detail).toContain('cursor 3');
    expect(busOnly.act).toEqual(['phm fleet claim-drift --json', 'phm agents bus show env-bus']);
    expect(busOnly.jobIds).toBeUndefined();

    const coordOnly = items.find(i => i.id.startsWith('claim-drift:coord:env-coord:9:'))!;
    expect(coordOnly).toMatchObject({
      kind: 'claim-drift-coordination', severity: 'warn', blocking: false,
      title: 'Claim drift · coordination-only lease on env-coord',
      since: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
    });
    expect(coordOnly.detail).toContain('queue:env-coord');
    expect(coordOnly.detail).toContain('agent:coord-owner');
    expect(coordOnly.act).toEqual(['phm fleet claim-drift --json', 'phm agents bus claim list --key queue:env-coord']);

    const mismatch = items.find(i => i.id.startsWith('claim-drift:owner:env-owner:5:'))!;
    expect(mismatch).toMatchObject({
      kind: 'claim-drift-owner', severity: 'warn', blocking: false,
      title: 'Claim drift · owner mismatch on env-owner',
    });
    expect(mismatch.detail).toContain('agent:bus-side');
    expect(mismatch.detail).toContain('agent:coord-side');
    expect(mismatch.act).toEqual([
      'phm fleet claim-drift --json',
      'phm agents bus show env-owner',
      'phm agents bus claim list --key queue:env-owner',
    ]);
  });

  it('reports VERIFIED healthy-empty, both-stores-missing as missing, and UNKNOWN or a throwing read as unavailable', async () => {
    const verified = await readDrift(drift());
    expect(verified.sources['claim-drift']).toEqual({ state: 'healthy', pending: 0 });
    expect(verified.items.filter(i => i.source === 'claim-drift')).toHaveLength(0);

    const absent = await readDrift(drift({ bus: 'missing', coordination: 'missing' }));
    expect(absent.sources['claim-drift']).toEqual({ state: 'missing', pending: 0 });

    // One store still present keeps VERIFIED healthy — an absent side is an
    // empty claim set, not a missing source.
    const half = await readDrift(drift({ bus: 'missing' }));
    expect(half.sources['claim-drift']).toEqual({ state: 'healthy', pending: 0 });

    const unknown = await readDrift(drift({
      state: 'UNKNOWN', bus: 'unavailable', missing: ['bus'],
      busOnly: [driftRow()], // a seam that still returns rows under UNKNOWN never lists them
    }));
    expect(unknown.sources['claim-drift']).toEqual({ state: 'unavailable', pending: null });
    expect(unknown.items.filter(i => i.source === 'claim-drift')).toHaveLength(0);

    const throwing = await read({
      readClaimDrift: () => { throw new Error('drift boom'); },
    });
    expect(throwing.sources['claim-drift']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'claim-drift')).toHaveLength(0);
  });

  it('maps an unparseable coord receipt stamp to a null since — unknown stays unknown', async () => {
    const inbox = await readDrift(drift({
      state: 'DRIFT',
      coordOnly: [driftRow({
        id: 'env-old', cursor: 0, receivedAt: '1970-01-01T00:00:00.000Z',
        sourceId: 'env-old:garbage',
      })],
    }));
    const item = inbox.items.find(i => i.source === 'claim-drift')!;
    expect(item.since).toBeNull();
    expect(item.expiresAt).toBe(new Date(now + 600_000).toISOString());
  });

  it('narrows under --source and --kind like every other source', async () => {
    const pending = drift({
      state: 'DRIFT',
      busOnly: [driftRow({ id: 'env-bus' })],
      ownerMismatch: [driftRow({ id: 'env-owner', busOwner: 'a', coordOwner: 'b' })],
    });
    const bySource = await readDrift(pending, { filter: { source: 'claim-drift' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'claim-drift')).toBe(true);
    const byKind = await readDrift(pending, { filter: { kind: 'claim-drift-owner' } });
    expect(byKind.items.map(i => i.id)).toEqual([`claim-drift:owner:env-owner:7:${new Date(now - 60_000).toISOString()}`]);
    expect(byKind.sources['claim-drift']).toEqual({ state: 'healthy', pending: 2 });
    // A drift row provably names no job — --job never matches it.
    const byJob = await readDrift(pending, { filter: { job: 'job-1' } });
    expect(byJob.items.filter(i => i.source === 'claim-drift')).toHaveLength(0);
  });
});

describe('readUnifiedInbox leader replies', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const replyPending = (over: Partial<LeaderReplyPending> = {}): LeaderReplyPending => ({
    hash: HASH_A, state: 'failed',
    since: new Date(now - 30 * 60_000).toISOString(),
    lastAt: new Date(now - 10 * 60_000).toISOString(),
    failedAttempts: 2, claimedAt: null,
    reply: null,
    ...over,
  });
  const repliesLedger = (over: Partial<LeaderRepliesLedgerRead> = {}): LeaderRepliesLedgerRead => ({
    state: 'healthy', items: [], ...over,
  });
  const readReplies = (r: LeaderRepliesLedgerRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readLeaderReplies: async () => r, ...extra });

  it('lists failed and orphaned replies as warns with their own kinds, stamps and acts', async () => {
    const inbox = await readReplies(repliesLedger({
      items: [
        replyPending({
          hash: HASH_A, state: 'failed', failedAttempts: 3,
          reply: { at: '2026-11-07 09:30', text: 'the deploy is green' },
        }),
        replyPending({
          hash: HASH_B, state: 'orphaned', failedAttempts: 0,
          claimedAt: new Date(now - 3 * 3_600_000).toISOString(),
          since: new Date(now - 3 * 3_600_000).toISOString(),
          reply: { at: '2026-11-07T09:00:00.000Z', text: 'standup moved to 9' },
        }),
      ],
    }));
    expect(inbox.sources['leader-replies']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'leader-replies');
    expect(items).toHaveLength(2);

    const failed = items.find(i => i.id === `leader-replies:${HASH_A}`)!;
    expect(failed).toMatchObject({
      kind: 'leader-reply-failed', severity: 'warn', blocking: false,
      title: 'iMessage leader reply failed',
      since: new Date(now - 30 * 60_000).toISOString(),
      expiresAt: null,
    });
    expect(failed.detail).toContain('"the deploy is green"');
    expect(failed.detail).toContain('outbox 2026-11-07 09:30');
    expect(failed.detail).toContain('failed after 3 recorded send attempts');
    expect(failed.act).toEqual(['phm imessage replies --json', 'phm leader replies --json']);
    expect(failed.jobIds).toBeUndefined();

    const orphaned = items.find(i => i.id === `leader-replies:${HASH_B}`)!;
    expect(orphaned).toMatchObject({
      kind: 'leader-reply-orphaned', severity: 'warn', blocking: false,
      title: 'iMessage leader reply unconfirmed',
      since: new Date(now - 3 * 3_600_000).toISOString(),
    });
    expect(orphaned.detail).toContain('"standup moved to 9"');
    expect(orphaned.detail).toContain('no outcome ever recorded');
    expect(orphaned.detail).toContain('no pass retries it');
    expect(orphaned.act).toEqual([
      'phm imessage replies --json',
      'phm leader replies --json',
      'phm comms send-owner --text "<same reply text>"',
    ]);
  });

  it('says honestly when the reply text is not in the current outbox read', async () => {
    const inbox = await readReplies(repliesLedger({
      items: [replyPending({ hash: HASH_A, state: 'failed', failedAttempts: 1, reply: null })],
    }));
    const item = inbox.items.find(i => i.source === 'leader-replies')!;
    expect(item.detail).toContain('reply text unresolved');
    expect(item.detail).toContain('not in the current outbox read');
    expect(item.detail).toContain('failed after 1 recorded send attempt');
    expect(item.detail).toContain('awaiting the next live replies pass');
  });

  it('reports missing and unavailable honestly and never lists seam rows under them', async () => {
    const missing = await readReplies(repliesLedger({ state: 'missing' }));
    expect(missing.sources['leader-replies']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'leader-replies')).toHaveLength(0);

    const unavailable = await readReplies(repliesLedger({
      state: 'unavailable', items: [replyPending()],
    }));
    expect(unavailable.sources['leader-replies']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'leader-replies')).toHaveLength(0);

    const degraded = await readReplies(repliesLedger({
      state: 'degraded', items: [replyPending()],
    }));
    expect(degraded.sources['leader-replies']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'leader-replies')).toHaveLength(1);

    const throwing = await read({
      readLeaderReplies: () => { throw new Error('ledger boom'); },
    });
    expect(throwing.sources['leader-replies']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'leader-replies')).toHaveLength(0);
  });

  it('reads the real ledger and resolves reply text through the outbox journals', async () => {
    const imessageDir = join(runsDir, 'imessage');
    mkdirSync(imessageDir, { recursive: true, mode: 0o700 });
    const hFail = replyTextHash('the deploy is green');
    const hOrph = replyTextHash('standup moved to 9');
    const hFresh = replyTextHash('fresh reply');
    const hSent = replyTextHash('already sent');
    const rows = [
      { at: '2026-11-07T10:00:00.000Z', hash: 'start', status: 'baseline' },
      { at: '2026-11-07T10:00:00.000Z', hash: hFail, status: 'pending' },
      { at: '2026-11-07T10:05:00.000Z', hash: hFail, status: 'failed' },
      { at: '2026-11-07T11:00:00.000Z', hash: hFail, status: 'failed' },
      { at: '2026-11-07T09:00:00.000Z', hash: hOrph, status: 'pending' },
      { at: '2026-11-07T11:59:00.000Z', hash: hFresh, status: 'pending' },
      { at: '2026-11-07T10:00:00.000Z', hash: hSent, status: 'pending' },
      { at: '2026-11-07T10:01:00.000Z', hash: hSent, status: 'sent' },
      // A torn line is skipped, never guessed.
      '{"at":"not-a-date","hash":"' + hFail + '","status":"failed"}',
    ];
    writeFileSync(join(imessageDir, 'leader-sent.jsonl'), rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    mkdirSync(join(runsDir, 'leader'), { recursive: true, mode: 0o700 });
    writeFileSync(join(runsDir, 'leader', 'MASON-OUTBOX.md'), '## 2026-11-07T09:30:00Z\nstandup moved to 9\n', { mode: 0o600 });

    const inbox = await read();
    expect(inbox.sources['leader-replies']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'leader-replies');
    expect(items).toHaveLength(2);

    const orphaned = items.find(i => i.id === `leader-replies:${hOrph}`)!;
    expect(orphaned).toMatchObject({
      kind: 'leader-reply-orphaned', severity: 'warn', blocking: false,
      since: '2026-11-07T09:00:00.000Z',
    });
    expect(orphaned.detail).toContain('"standup moved to 9"');
    expect(orphaned.detail).toContain('outbox 2026-11-07T09:30:00Z');

    const failed = items.find(i => i.id === `leader-replies:${hFail}`)!;
    expect(failed).toMatchObject({
      kind: 'leader-reply-failed', severity: 'warn', blocking: false,
      since: '2026-11-07T10:00:00.000Z',
    });
    expect(failed.detail).toContain('reply text not in the current outbox read');
    expect(failed.detail).toContain('failed after 2 recorded send attempts');
  });

  it('reports a missing ledger as missing and an unreadable one as unavailable', async () => {
    const missing = await read();
    expect(missing.sources['leader-replies']).toEqual({ state: 'missing', pending: 0 });

    const imessageDir = join(runsDir, 'imessage');
    mkdirSync(imessageDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(imessageDir, 'leader-sent.jsonl'), 'not json at all\n', { mode: 0o600 });
    chmodSync(join(imessageDir, 'leader-sent.jsonl'), 0o600);
    const garbage = await read();
    // On-contract rows: none — a readable ledger with no valid rows is healthy-empty.
    expect(garbage.sources['leader-replies']).toEqual({ state: 'healthy', pending: 0 });

    rmSync(join(imessageDir, 'leader-sent.jsonl'));
    mkdirSync(join(imessageDir, 'leader-sent.jsonl'), { recursive: true });
    const unavailable = await read();
    expect(unavailable.sources['leader-replies']).toEqual({ state: 'unavailable', pending: null });
  });

  it('narrows under --source and --kind like every other source', async () => {
    const pending = repliesLedger({
      items: [
        replyPending({ hash: HASH_A, state: 'failed' }),
        replyPending({ hash: HASH_B, state: 'orphaned', claimedAt: new Date(now - 3_600_000).toISOString() }),
      ],
    });
    const bySource = await readReplies(pending, { filter: { source: 'leader-replies' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'leader-replies')).toBe(true);
    const byKind = await readReplies(pending, { filter: { kind: 'leader-reply-orphaned' } });
    expect(byKind.items.map(i => i.id)).toEqual([`leader-replies:${HASH_B}`]);
    expect(byKind.sources['leader-replies']).toEqual({ state: 'healthy', pending: 2 });
    // A send-ledger row provably names no job — --job never matches it.
    const byJob = await readReplies(pending, { filter: { job: 'job-1' } });
    expect(byJob.items.filter(i => i.source === 'leader-replies')).toHaveLength(0);
  });
});

describe('readUnifiedInbox send gate', () => {
  // Verdict shapes arrive through the option seams so this suite stays out of
  // the sandbox-policy owner lane.
  type KillRead = ReturnType<NonNullable<UnifiedInboxOptions['readKillSwitch']>>;
  type PauseRead = ReturnType<NonNullable<UnifiedInboxOptions['probePause']>>;
  const killInactive = { state: 'inactive', sourceState: 'healthy', reason: 'missing', path: '/k' } as const;
  const killActive = { state: 'active', sourceState: 'healthy', reason: 'present', path: '/k' } as const;
  const killUnknown = { state: 'unknown', sourceState: 'degraded', reason: 'uninspectable', path: '/k', errorCode: null } as const;
  const pauseClear = { state: 'clear', since: null, reason: null } as const;
  const pauseSet = (since: number | null) => ({ state: 'paused', since, reason: null }) as const;
  const pauseUnknown = { state: 'unknown', since: null, reason: 'is not valid JSON' } as const;
  const readGate = (kill: KillRead, pause: PauseRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readKillSwitch: () => kill, probePause: () => pause, ...extra });

  it('reports a verified-open gate healthy with a real zero under the default reads', async () => {
    const inbox = await read();
    expect(inbox.sources['send-gate']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'send-gate')).toHaveLength(0);
  });

  it('lists an engaged kill switch as a high item with its release act', async () => {
    const inbox = await readGate(killActive, pauseClear);
    expect(inbox.sources['send-gate']).toEqual({ state: 'healthy', pending: 1 });
    const item = inbox.items.find(i => i.id === 'send-gate:kill')!;
    expect(item).toMatchObject({
      source: 'send-gate', kind: 'send-gate-kill', severity: 'high', blocking: false,
      title: 'Kill switch engaged — bus writes held',
      since: null, expiresAt: null,
    });
    expect(item.detail).toContain('claims, sends and every local bus write refuse');
    expect(item.act).toEqual(['phm fleet resume', 'phm agents bus status --json', 'phm fleet status']);
    expect(item.jobIds).toBeUndefined();
  });

  it('lists a set pause flag as a high item carrying its recorded start', async () => {
    const pauseSince = now - 3_600_000;
    const inbox = await readGate(killInactive, pauseSet(pauseSince));
    expect(inbox.sources['send-gate']).toEqual({ state: 'healthy', pending: 1 });
    const item = inbox.items.find(i => i.id === 'send-gate:pause')!;
    expect(item).toMatchObject({
      source: 'send-gate', kind: 'send-gate-pause', severity: 'high', blocking: false,
      title: 'Comms pause set — bus writes held',
      since: new Date(pauseSince).toISOString(), expiresAt: null,
    });
    expect(item.detail).toContain(`since ${new Date(pauseSince).toISOString()}`);
    expect(item.act).toEqual(['phm agents bus status --json', 'phm fleet status']);
  });

  it('keeps a paused flag without a recorded start honestly undated', async () => {
    const inbox = await readGate(killInactive, pauseSet(null));
    const item = inbox.items.find(i => i.id === 'send-gate:pause')!;
    expect(item.since).toBeNull();
    expect(item.detail).not.toContain('since ');
  });

  it('lists both engaged gates as two items', async () => {
    const inbox = await readGate(killActive, pauseSet(now - 60_000));
    expect(inbox.sources['send-gate']).toEqual({ state: 'healthy', pending: 2 });
    expect(inbox.items.filter(i => i.source === 'send-gate').map(i => i.id).sort())
      .toEqual(['send-gate:kill', 'send-gate:pause']);
  });

  it('reports an uninspectable gate warn at degraded — fail-closed, never called a decision', async () => {
    const inbox = await readGate(killUnknown, pauseUnknown);
    expect(inbox.sources['send-gate']).toEqual({ state: 'degraded', pending: 2 });
    const kill = inbox.items.find(i => i.id === 'send-gate:kill')!;
    expect(kill).toMatchObject({ kind: 'send-gate-kill', severity: 'warn' });
    expect(kill.title).toBe('Kill switch state unknown — writes refused');
    expect(kill.detail).toContain('uninspectable');
    expect(kill.act).toEqual(['phm agents bus status --json', 'phm fleet status']);
    const pause = inbox.items.find(i => i.id === 'send-gate:pause')!;
    expect(pause).toMatchObject({ kind: 'send-gate-pause', severity: 'warn', since: null });
    expect(pause.title).toBe('Comms pause state unknown — writes refused');
    expect(pause.detail).toContain('is not valid JSON');
  });

  it('keeps the surviving verdict when one probe throws', async () => {
    const inbox = await read({
      readKillSwitch: () => { throw new Error('kill boom'); },
      probePause: () => pauseSet(now - 60_000),
    });
    // The throw synthesizes the same unknown verdict the fail-closed send
    // path applies; the pause verdict still lists on its own.
    expect(inbox.sources['send-gate']).toEqual({ state: 'degraded', pending: 2 });
    expect(inbox.items.find(i => i.id === 'send-gate:kill')).toMatchObject({ severity: 'warn' });
    expect(inbox.items.find(i => i.id === 'send-gate:pause')).toMatchObject({ severity: 'high' });
  });

  it('narrows under --source and --kind like every other source', async () => {
    const pending = { kill: killActive, pause: pauseSet(now - 60_000) };
    const bySource = await readGate(pending.kill, pending.pause, { filter: { source: 'send-gate' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'send-gate')).toBe(true);
    const byKind = await readGate(pending.kill, pending.pause, { filter: { kind: 'send-gate-kill' } });
    expect(byKind.items.map(i => i.id)).toEqual(['send-gate:kill']);
    expect(byKind.sources['send-gate']).toEqual({ state: 'healthy', pending: 2 });
    // A gate verdict names no job — --job never matches it.
    const byJob = await readGate(pending.kill, pending.pause, { filter: { job: 'job-1' } });
    expect(byJob.items.filter(i => i.source === 'send-gate')).toHaveLength(0);
  });
});

describe('readUnifiedInbox router queue', () => {
  const queueRead = (over: Partial<RouterQueueStuckRead> = {}): RouterQueueStuckRead => ({
    state: 'healthy', jobs: [], ...over,
  });
  const readQueue = (q: RouterQueueStuckRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readRouterQueue: async () => q, ...extra });
  /** dispatch-events.log stamps are local wall time; build them from `now` so the read is TZ-proof. */
  const localStamp = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const writeQueue = (lines: string[]): void => {
    const dir = join(runsDir, 'queue');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'router-queue.md'), `${lines.join('\n')}\n`, { mode: 0o600 });
  };

  it('lists each unlaunched READY job as a warn naming its id, wait and acts', async () => {
    const inbox = await readQueue(queueRead({ jobs: [
      { id: 'RQ-ALPHA', age_s: 7_200 },
      { id: 'RQ-BETA', age: 'unknown' },
    ] }));
    expect(inbox.sources['router-queue']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'router-queue');
    expect(items).toHaveLength(2);

    const alpha = items.find(i => i.id === 'router-queue:RQ-ALPHA')!;
    expect(alpha).toMatchObject({
      kind: 'router-queue-job', severity: 'warn', blocking: false,
      title: 'Router job RQ-ALPHA has no recorded launch',
      since: new Date(now - 7_200_000).toISOString(), expiresAt: null,
      jobIds: ['RQ-ALPHA'],
    });
    expect(alpha.detail).toContain('READY in queue/router-queue.md');
    expect(alpha.detail).toContain('waiting 2h');
    expect(alpha.act).toEqual(['phm queue stuck', 'phm fleet unfed --json', 'phm queue']);

    // Neither an enqueue epoch nor a dispatch event — the wait stays unknown.
    const beta = items.find(i => i.id === 'router-queue:RQ-BETA')!;
    expect(beta.since).toBeNull();
    expect(beta.detail).toContain('wait age unknown');
    expect(beta.jobIds).toEqual(['RQ-BETA']);
  });

  it('reports missing and unavailable honestly and never lists seam rows under them', async () => {
    const missing = await readQueue(queueRead({ state: 'missing', jobs: [{ id: 'RQ-X', age_s: 1 }] }));
    expect(missing.sources['router-queue']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'router-queue')).toHaveLength(0);

    const unavailable = await readQueue(queueRead({ state: 'unavailable', jobs: [{ id: 'RQ-X', age_s: 1 }] }));
    expect(unavailable.sources['router-queue']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'router-queue')).toHaveLength(0);

    const throwing = await read({ readRouterQueue: async () => { throw new Error('queue boom'); } });
    expect(throwing.sources['router-queue']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'router-queue')).toHaveLength(0);
  });

  it('lists every READY row degraded when launch evidence is unavailable, saying so in the detail', async () => {
    const inbox = await readQueue(queueRead({ state: 'degraded', jobs: [{ id: 'RQ-ALPHA', age_s: 600 }] }));
    expect(inbox.sources['router-queue']).toEqual({ state: 'degraded', pending: 1 });
    const item = inbox.items.find(i => i.id === 'router-queue:RQ-ALPHA')!;
    expect(item.detail).toContain('waiting 10m');
    expect(item.detail).toContain('launch evidence unavailable');
  });

  it('reads the real queue file and events log under runsDir', async () => {
    writeQueue([
      `- READY RQ-ALPHA enq=${Math.floor((now - 7_200_000) / 1000)}`,
      '- READY RQ-BETA',
      `- READY RQ-GAMMA enq=${Math.floor((now - 600_000) / 1000)}`,
      `- DONE RQ-OLD enq=${Math.floor((now - 7_200_000) / 1000)}`,
    ]);
    writeFileSync(join(runsDir, 'dispatch-events.log'),
      `${localStamp(now - 300_000)} LAUNCH RQ-GAMMA\n${localStamp(now - 7_300_000)} NOTE RQ-BETA picked up\n`,
      { mode: 0o600 });
    const inbox = await read();
    expect(inbox.sources['router-queue']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'router-queue');
    expect(items.map(i => i.id).sort()).toEqual(['router-queue:RQ-ALPHA', 'router-queue:RQ-BETA']);
    expect(items.find(i => i.id === 'router-queue:RQ-ALPHA')!.since).toBe(new Date(now - 7_200_000).toISOString());
    // No enq= on the row: the first dispatch-event mention is the wait's start.
    expect(items.find(i => i.id === 'router-queue:RQ-BETA')!.since).toBe(new Date(now - 7_300_000).toISOString());
  });

  it('degrades when the events log is missing but still lists READY rows, and reports a missing queue file as missing', async () => {
    writeQueue([`- READY RQ-ALPHA enq=${Math.floor((now - 600_000) / 1000)}`]);
    const degraded = await read();
    expect(degraded.sources['router-queue']).toEqual({ state: 'degraded', pending: 1 });
    const item = degraded.items.find(i => i.source === 'router-queue')!;
    expect(item.detail).toContain('launch evidence unavailable');

    rmSync(join(runsDir, 'queue', 'router-queue.md'));
    const missing = await read();
    expect(missing.sources['router-queue']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'router-queue')).toHaveLength(0);
  });

  it('narrows under --source, --kind and --job like every other source', async () => {
    const pending = queueRead({ jobs: [{ id: 'RQ-ALPHA', age_s: 600 }, { id: 'RQ-BETA', age_s: 60 }] });
    const bySource = await readQueue(pending, { filter: { source: 'router-queue' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'router-queue')).toBe(true);
    const byKind = await readQueue(pending, { filter: { kind: 'router-queue-job' } });
    expect(byKind.items.map(i => i.id).sort()).toEqual(['router-queue:RQ-ALPHA', 'router-queue:RQ-BETA']);
    expect(byKind.sources['router-queue']).toEqual({ state: 'healthy', pending: 2 });
    // The READY id is the item's own citation — --job names it directly.
    const byJob = await readQueue(pending, { filter: { job: 'RQ-ALPHA' } });
    expect(byJob.items.filter(i => i.source === 'router-queue').map(i => i.id)).toEqual(['router-queue:RQ-ALPHA']);
  });
});

describe('readUnifiedInbox jobs stuck', () => {
  const stuckRead = (over: Partial<JobsStuckSourceRead> = {}): JobsStuckSourceRead => ({
    state: 'healthy', jobs: [], ...over,
  });
  const readStuck = (s: JobsStuckSourceRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readJobsStuck: async () => s, ...extra });
  const stuckJob = (over: Partial<RunningStuckJob> = {}): RunningStuckJob => ({
    job: 'J-STUCK', lane: 'codex-local', kind: 'stuck', pid: 4242,
    age_min: 125, last_log_at: '2026-11-07T09:00:00.000Z',
    why: 'log silent for 45m', ...over,
  });

  it('lists each ghost and stuck marker as a warn naming its id, age, last log and acts', async () => {
    const inbox = await readStuck(stuckRead({ jobs: [
      stuckJob({ job: 'J-GHOST', kind: 'ghost', age_min: 200, last_log_at: null,
        why: 'its process (pid 4242) is gone but the run marker is still open' }),
      stuckJob(),
      stuckJob({ job: 'J-UNDATED', age_min: null, last_log_at: null, why: 'no log after 3h' }),
    ] }));
    expect(inbox.sources['jobs-stuck']).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'jobs-stuck');
    expect(items).toHaveLength(3);

    const ghost = items.find(i => i.id === 'jobs-stuck:J-GHOST')!;
    expect(ghost).toMatchObject({
      kind: 'stuck-ghost', severity: 'warn', blocking: false,
      title: 'Job J-GHOST counted running but its process is gone',
      since: new Date(now - 200 * 60_000).toISOString(), expiresAt: null,
      jobIds: ['J-GHOST'],
    });
    expect(ghost.detail).toContain('lane codex-local');
    expect(ghost.detail).toContain('age 3h20m');
    expect(ghost.detail).toContain('last log none');
    expect(ghost.act).toEqual(['phm jobs stuck', 'phm fleet stray-stop --stuck --apply']);

    const stuck = items.find(i => i.id === 'jobs-stuck:J-STUCK')!;
    expect(stuck).toMatchObject({
      kind: 'stuck-job', severity: 'warn', blocking: false,
      title: 'Job J-STUCK running with a silent log',
      since: new Date(now - 125 * 60_000).toISOString(), expiresAt: null,
      jobIds: ['J-STUCK'],
    });
    expect(stuck.detail).toContain('age 2h5m');
    expect(stuck.detail).toContain('last log 2026-11-07T09:00:00.000Z');
    expect(stuck.detail).toContain('log silent for 45m');

    // age_min null — the marker kept no start — stays honestly undated.
    const undated = items.find(i => i.id === 'jobs-stuck:J-UNDATED')!;
    expect(undated.since).toBeNull();
    expect(undated.detail).toContain('age unknown');
    expect(undated.detail).toContain('last log none');
  });

  it('reports missing and unavailable honestly and never lists seam rows under them', async () => {
    const missing = await readStuck(stuckRead({ state: 'missing', jobs: [stuckJob()] }));
    expect(missing.sources['jobs-stuck']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'jobs-stuck')).toHaveLength(0);

    const unavailable = await readStuck(stuckRead({ state: 'unavailable', jobs: [stuckJob()] }));
    expect(unavailable.sources['jobs-stuck']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'jobs-stuck')).toHaveLength(0);

    const throwing = await read({ readJobsStuck: async () => { throw new Error('markers boom'); } });
    expect(throwing.sources['jobs-stuck']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'jobs-stuck')).toHaveLength(0);

    // A degraded read still lists what it found, pending counted.
    const degraded = await readStuck(stuckRead({ state: 'degraded', jobs: [stuckJob()] }));
    expect(degraded.sources['jobs-stuck']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'jobs-stuck')).toHaveLength(1);
  });

  it('reads the real run markers under runsDir: a dead-pid marker is a ghost, a silent old log is stuck', async () => {
    const runDir = join(runsDir, 'queue', 'run');
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const dispatchedSecs = (msAgo: number) => String(Math.floor((now - msAgo) / 1000));
    // Marker layout: queue/run/<job>.{line,dispatched,fin}; <job>.{launch,log,base} at the runs root.
    // Ghost: a pid no OS can hand out, marker still open, started 3h ago.
    writeFileSync(join(runDir, 'J-GHOST.line'), 'J-GHOST\tashlrai/phantom\tcodex-local\n', { mode: 0o600 });
    writeFileSync(join(runDir, 'J-GHOST.dispatched'), dispatchedSecs(3 * 3_600_000), { mode: 0o600 });
    writeFileSync(join(runsDir, 'J-GHOST.launch'), 'pid 16777216\n', { mode: 0o600 });
    // Stuck: the test process's own pid is alive; started 100m ago, log quiet 40m.
    writeFileSync(join(runDir, 'J-STUCK.line'), 'J-STUCK\tashlrai/phantom\tcodex-local\n', { mode: 0o600 });
    writeFileSync(join(runDir, 'J-STUCK.dispatched'), dispatchedSecs(100 * 60_000), { mode: 0o600 });
    writeFileSync(join(runsDir, 'J-STUCK.launch'), `pid ${process.pid}\n`, { mode: 0o600 });
    writeFileSync(join(runsDir, 'J-STUCK.log'), 'fake log\n', { mode: 0o600 });
    utimesSync(join(runsDir, 'J-STUCK.log'), new Date(now - 40 * 60_000), new Date(now - 40 * 60_000));
    // Healthy: started 10m ago with a fresh log and a live pid — running, not stuck.
    writeFileSync(join(runDir, 'J-OK.line'), 'J-OK\tashlrai/phantom\tcodex-local\n', { mode: 0o600 });
    writeFileSync(join(runDir, 'J-OK.dispatched'), dispatchedSecs(10 * 60_000), { mode: 0o600 });
    writeFileSync(join(runsDir, 'J-OK.launch'), `pid ${process.pid}\n`, { mode: 0o600 });
    writeFileSync(join(runsDir, 'J-OK.log'), 'fake log\n', { mode: 0o600 });
    // Finished: an unmatched .fin with no .base closes the marker — never lists.
    writeFileSync(join(runDir, 'J-DONE.line'), 'J-DONE\tashlrai/phantom\tcodex-local\n', { mode: 0o600 });
    writeFileSync(join(runDir, 'J-DONE.dispatched'), dispatchedSecs(3 * 3_600_000), { mode: 0o600 });
    writeFileSync(join(runsDir, 'J-DONE.launch'), 'pid 16777216\n', { mode: 0o600 });
    writeFileSync(join(runDir, 'J-DONE.fin'), '0\n', { mode: 0o600 });

    const inbox = await read();
    expect(inbox.sources['jobs-stuck']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'jobs-stuck');
    expect(items.map(i => i.id).sort()).toEqual(['jobs-stuck:J-GHOST', 'jobs-stuck:J-STUCK']);
    const ghost = items.find(i => i.id === 'jobs-stuck:J-GHOST')!;
    expect(ghost).toMatchObject({
      kind: 'stuck-ghost', severity: 'warn',
      since: new Date(now - 3 * 3_600_000).toISOString(),
      jobIds: ['J-GHOST'],
    });
    expect(ghost.detail).toContain('lane codex-local');
    expect(ghost.detail).toContain('its process (pid 16777216) is gone');
    const stuck = items.find(i => i.id === 'jobs-stuck:J-STUCK')!;
    expect(stuck).toMatchObject({
      kind: 'stuck-job', severity: 'warn',
      since: new Date(now - 100 * 60_000).toISOString(),
      jobIds: ['J-STUCK'],
    });
    expect(stuck.detail).toContain('log silent for');
  });

  it('reports a missing marker dir as missing and an unlistable one as unavailable', async () => {
    // No queue/run at all — verified-absent, so nothing can be running.
    const missing = await read();
    expect(missing.sources['jobs-stuck']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'jobs-stuck')).toHaveLength(0);

    // queue/run exists but is a file — readdir cannot list it, so the
    // stuck set is unknown rather than a fabricated empty read.
    mkdirSync(join(runsDir, 'queue'), { recursive: true, mode: 0o700 });
    writeFileSync(join(runsDir, 'queue', 'run'), 'not a dir\n', { mode: 0o600 });
    const unavailable = await read();
    expect(unavailable.sources['jobs-stuck']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'jobs-stuck')).toHaveLength(0);
  });

  it('narrows under --source, --kind and --job like every other source', async () => {
    const pending = stuckRead({ jobs: [stuckJob({ job: 'J-GHOST', kind: 'ghost' }), stuckJob({ job: 'J-STUCK' })] });
    const bySource = await readStuck(pending, { filter: { source: 'jobs-stuck' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'jobs-stuck')).toBe(true);
    const byKind = await readStuck(pending, { filter: { kind: 'stuck-ghost' } });
    expect(byKind.items.map(i => i.id)).toEqual(['jobs-stuck:J-GHOST']);
    expect(byKind.sources['jobs-stuck']).toEqual({ state: 'healthy', pending: 2 });
    // The marker's job id is the item's own citation — --job names it directly.
    const byJob = await readStuck(pending, { filter: { job: 'J-STUCK' } });
    expect(byJob.items.filter(i => i.source === 'jobs-stuck').map(i => i.id)).toEqual(['jobs-stuck:J-STUCK']);
  });
});

describe('readUnifiedInbox queue parked', () => {
  const parkedRead = (over: Partial<QueueParkedRead> = {}): QueueParkedRead => ({
    state: 'healthy', waiting: [], stale: [], groups: [], ...over,
  });
  const parkedGroup = (over: Partial<ParkedGroup> = {}): ParkedGroup => ({
    reason: 'BYHAND', lane: 'devin', count: 2, jobs: ['RQ-HAND-1', 'RQ-HAND-2'], ...over,
  });
  const readParked = (q: QueueParkedRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readQueueParked: async () => q, ...extra });
  const waiting = (over: Partial<ParkedUnmetDep> = {}): ParkedUnmetDep => ({
    job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-GATE-1'], ...over,
  });
  const stale = (over: Partial<ParkedMetDep> = {}): ParkedMetDep => ({
    job: 'RQ-STALE', lane: 'codex-local', gates: ['RQ-DONE'], ...over,
  });

  it('lists each parked row once under its own state — waiting info, stale warn', async () => {
    const inbox = await readParked(parkedRead({
      waiting: [waiting({ unmet: ['RQ-GATE-1', 'RQ-GATE-2'] }), waiting({ job: 'RQ-WAIT-2', lane: null, unmet: ['RQ-GATE-3'] })],
      stale: [stale()],
    }));
    expect(inbox.sources['queue-parked']).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'queue-parked');
    expect(items).toHaveLength(3);

    const wait = items.find(i => i.id === 'queue-parked:RQ-WAIT')!;
    expect(wait).toMatchObject({
      kind: 'parked-dep-waiting', severity: 'info', blocking: false,
      title: 'Job RQ-WAIT parked on unmet dependency gates',
      since: null, expiresAt: null,
      jobIds: ['RQ-GATE-1', 'RQ-GATE-2', 'RQ-WAIT'],
      act: ['phm fleet queue-parked', 'phm fleet autopilot --once'],
    });
    expect(wait.detail).toContain('lane devin');
    expect(wait.detail).toContain('waiting on gates RQ-GATE-1, RQ-GATE-2');
    expect(wait.detail).toContain('no MERGED outcome recorded');

    const noLane = items.find(i => i.id === 'queue-parked:RQ-WAIT-2')!;
    expect(noLane.detail).toContain('lane unknown');

    const staleItem = items.find(i => i.id === 'queue-parked:RQ-STALE')!;
    expect(staleItem).toMatchObject({
      kind: 'parked-dep-stale', severity: 'warn', blocking: false,
      title: 'Job RQ-STALE parked past merged dependency gates',
      since: null, expiresAt: null,
      jobIds: ['RQ-DONE', 'RQ-STALE'],
    });
    expect(staleItem.detail).toContain('all gates MERGED (RQ-DONE)');
    expect(staleItem.detail).toContain('never unparked');
  });

  it('lists each non-dependency parked group once as info parked-group, never borrowing the dep verdicts', async () => {
    const inbox = await readParked(parkedRead({
      waiting: [waiting()],
      groups: [
        parkedGroup(),
        parkedGroup({ reason: 'MERGERATE', lane: 'codex-local', count: 9, jobs: ['RQ-M-1', 'RQ-M-2', 'RQ-M-3', 'RQ-M-4', 'RQ-M-5', 'RQ-M-6', 'RQ-M-7', 'RQ-M-8'] }),
        parkedGroup({ reason: 'HOLD', lane: null, count: 1, jobs: ['RQ-HOLD-1'] }),
      ],
    }));
    expect(inbox.sources['queue-parked']).toEqual({ state: 'healthy', pending: 4 });
    const items = inbox.items.filter(i => i.source === 'queue-parked');
    expect(items).toHaveLength(4);

    const byHand = items.find(i => i.id === 'queue-parked:BYHAND:devin')!;
    expect(byHand).toMatchObject({
      kind: 'parked-group', severity: 'info', blocking: false,
      title: '2 jobs parked BYHAND',
      since: null, expiresAt: null,
      jobIds: ['RQ-HAND-1', 'RQ-HAND-2'],
      act: ['phm fleet queue-parked', 'phm fleet parked'],
    });
    expect(byHand.detail).toContain('lane devin');
    expect(byHand.detail).toContain('jobs RQ-HAND-1, RQ-HAND-2');
    expect(byHand.detail).toContain('non-dependency reason');

    // The group's true count is 9 but the projection lists only eight ids —
    // the overflow is named, never passed off as the whole set.
    const merge = items.find(i => i.id === 'queue-parked:MERGERATE:codex-local')!;
    expect(merge.title).toBe('9 jobs parked MERGERATE');
    expect(merge.detail).toContain('+1 more');
    expect(merge.jobIds).toHaveLength(8);

    const noLane = items.find(i => i.id === 'queue-parked:HOLD:unknown')!;
    expect(noLane.detail).toContain('lane unknown');
    expect(noLane.title).toBe('1 job parked HOLD');
  });

  it('suppresses parked groups under missing and unavailable like the dep rows', async () => {
    const groups = [parkedGroup()];
    const missing = await readParked(parkedRead({ state: 'missing', groups }));
    expect(missing.sources['queue-parked']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'queue-parked')).toHaveLength(0);

    const unavailable = await readParked(parkedRead({ state: 'unavailable', groups }));
    expect(unavailable.sources['queue-parked']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'queue-parked')).toHaveLength(0);
  });

  it('reports missing and unavailable honestly and never lists seam rows under them', async () => {
    const missing = await readParked(parkedRead({ state: 'missing', waiting: [waiting()], stale: [stale()] }));
    expect(missing.sources['queue-parked']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'queue-parked')).toHaveLength(0);

    const unavailable = await readParked(parkedRead({ state: 'unavailable', waiting: [waiting()], stale: [stale()] }));
    expect(unavailable.sources['queue-parked']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'queue-parked')).toHaveLength(0);

    const throwing = await read({ readQueueParked: async () => { throw new Error('queue boom'); } });
    expect(throwing.sources['queue-parked']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'queue-parked')).toHaveLength(0);
  });

  it('lists every parked row degraded when the ready read is partial, saying so in the detail', async () => {
    const inbox = await readParked(parkedRead({ state: 'degraded', waiting: [waiting()], stale: [stale()], groups: [parkedGroup()] }));
    expect(inbox.sources['queue-parked']).toEqual({ state: 'degraded', pending: 3 });
    for (const item of inbox.items.filter(i => i.source === 'queue-parked')) {
      expect(item.detail).toContain('ready.tsv read degraded');
    }
  });

  it('reads the real ready.tsv, prompts and jobs.jsonl under runsDir', async () => {
    mkdirSync(join(runsDir, 'queue', 'prompts'), { recursive: true });
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    const waitPrompt = join(runsDir, 'queue', 'prompts', 'wait.md');
    const stalePrompt = join(runsDir, 'queue', 'prompts', 'stale.md');
    writeFileSync(waitPrompt, 'DEPENDENCY GATE: RQ-OPEN, RQ-DONE\n', { mode: 0o600 });
    writeFileSync(stalePrompt, 'DEPENDENCY GATE: RQ-DONE\n', { mode: 0o600 });
    writeFileSync(join(runsDir, 'queue', 'ready.tsv'), [
      `PARKED-DEP.devin\tRQ-WAIT\tdevin\twork\tphantom\t${waitPrompt}`,
      `PARKED-DEP.codex-local\tRQ-STALE\tcodex-local\twork\tphantom\t${stalePrompt}`,
      'PARKED-BYHAND.devin\tRQ-HAND-1\tdevin\twork\tphantom\tprompts/hand1.md',
      'PARKED-BYHAND.devin\tRQ-HAND-2\tdevin\twork\tphantom\tprompts/hand2.md',
      'PARKED-DEPENDENCY.devin\tRQ-DEP-ALIAS\tdevin\twork\tphantom\tpool/x.md',
      'READY\tRQ-FREE\tdevin\twork\tphantom\tprompts/free.md',
    ].join('\n'), { mode: 0o600 });
    writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'),
      `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-DONE' })}\n`, { mode: 0o600 });

    const inbox = await read();
    // DEP rows keep their dedicated items; the DEP alias row has no prompt
    // gate ids so it lists nowhere — and the two BYHAND rows roll up into
    // one parked-group item, never one per job.
    expect(inbox.sources['queue-parked']).toEqual({ state: 'healthy', pending: 3 });
    const items = inbox.items.filter(i => i.source === 'queue-parked');
    expect(items.map(i => i.id).sort()).toEqual(['queue-parked:BYHAND:devin', 'queue-parked:RQ-STALE', 'queue-parked:RQ-WAIT']);
    const group = items.find(i => i.id === 'queue-parked:BYHAND:devin')!;
    expect(group).toMatchObject({ kind: 'parked-group', severity: 'info', blocking: false, title: '2 jobs parked BYHAND' });
    expect(group.jobIds).toEqual(['RQ-HAND-1', 'RQ-HAND-2']);
    expect(group.detail).toContain('lane devin');
    const waitItem = items.find(i => i.id === 'queue-parked:RQ-WAIT')!;
    expect(waitItem).toMatchObject({ kind: 'parked-dep-waiting', severity: 'info' });
    // Only the unmet gate is named — RQ-DONE merged, so this item never cites it.
    expect(waitItem.jobIds).toEqual(['RQ-OPEN', 'RQ-WAIT']);
    const staleItem = items.find(i => i.id === 'queue-parked:RQ-STALE')!;
    expect(staleItem).toMatchObject({ kind: 'parked-dep-stale', severity: 'warn' });
    expect(staleItem.jobIds).toEqual(['RQ-DONE', 'RQ-STALE']);
    // READY rows are the router-queue/market's concern, never this source's.
    expect(items.some(i => i.id === 'queue-parked:RQ-FREE')).toBe(false);
  });

  it('reports a missing ready.tsv as missing and an unreadable one degraded', async () => {
    const missing = await read();
    expect(missing.sources['queue-parked']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'queue-parked')).toHaveLength(0);

    mkdirSync(join(runsDir, 'queue'));
    // A directory where the file belongs is a read failure, not verified-empty.
    mkdirSync(join(runsDir, 'queue', 'ready.tsv'));
    const degraded = await read();
    expect(degraded.sources['queue-parked']).toEqual({ state: 'degraded', pending: 0 });
    expect(degraded.items.filter(i => i.source === 'queue-parked')).toHaveLength(0);
  });

  it('narrows under --source, --kind and --job like every other source', async () => {
    const pending = parkedRead({
      waiting: [waiting({ unmet: ['RQ-GATE-1', 'RQ-DONE'] })],
      stale: [stale()],
    });
    const bySource = await readParked(pending, { filter: { source: 'queue-parked' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'queue-parked')).toBe(true);
    const byKind = await readParked(pending, { filter: { kind: 'parked-dep-stale' } });
    expect(byKind.items.map(i => i.id)).toEqual(['queue-parked:RQ-STALE']);
    expect(byKind.sources['queue-parked']).toEqual({ state: 'healthy', pending: 2 });
    // The parked job's own id and each gate id it names are both citations.
    const byJob = await readParked(pending, { filter: { job: 'RQ-WAIT' } });
    expect(byJob.items.filter(i => i.source === 'queue-parked').map(i => i.id)).toEqual(['queue-parked:RQ-WAIT']);
    const byGate = await readParked(pending, { filter: { job: 'RQ-GATE-1' } });
    expect(byGate.items.filter(i => i.source === 'queue-parked').map(i => i.id)).toEqual(['queue-parked:RQ-WAIT']);
    const byGateStale = await readParked(pending, { filter: { job: 'RQ-DONE' } });
    expect(byGateStale.items.filter(i => i.source === 'queue-parked').map(i => i.id).sort())
      .toEqual(['queue-parked:RQ-STALE', 'queue-parked:RQ-WAIT']);
  });
});

describe('readUnifiedInbox stuck fixes', () => {
  const fixesRead = (over: Partial<StuckFixesSourceRead> = {}): StuckFixesSourceRead => ({
    state: 'healthy', stuck: [], ...over,
  });
  const readFixes = (s: StuckFixesSourceRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readStuckFixes: async () => s, ...extra });
  const stuckFix = (over: Partial<StuckFixRow> = {}): StuckFixRow => ({
    job: 'FIXUP-MAIN-ashlrai-phantom-abc1234', repo: 'ashlrai/phantom',
    prUrl: 'https://github.com/ashlrai/phantom/pull/4242',
    publishedAt: new Date(now - 45 * 60_000).toISOString(), ageMinutes: 45, ...over,
  });

  it('lists each stuck fix PR as a warn naming repo, PR url, job id, publish time and acts', async () => {
    const inbox = await readFixes(fixesRead({ stuck: [
      stuckFix(),
      stuckFix({ job: 'FIXUP-MAIN-ashlrai-website-def5678', repo: null,
        prUrl: 'https://github.com/ashlrai/website/pull/77', ageMinutes: 130,
        publishedAt: new Date(now - 130 * 60_000).toISOString() }),
    ] }));
    expect(inbox.sources['stuck-fixes']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'stuck-fixes');
    expect(items).toHaveLength(2);

    const fix = items.find(i => i.id === 'stuck-fixes:FIXUP-MAIN-ashlrai-phantom-abc1234')!;
    expect(fix).toMatchObject({
      kind: 'stuck-fix', severity: 'warn', blocking: false,
      title: 'ashlrai/phantom fix PR stuck 45 min',
      since: new Date(now - 45 * 60_000).toISOString(), expiresAt: null,
      jobIds: ['FIXUP-MAIN-ashlrai-phantom-abc1234'],
      act: ['phm fleet stuck-fixes', 'phm fleet main-health'],
    });
    expect(fix.detail).toContain('job FIXUP-MAIN-ashlrai-phantom-abc1234');
    expect(fix.detail).toContain('https://github.com/ashlrai/phantom/pull/4242');
    expect(fix.detail).toContain('no MERGED/CLOSED outcome recorded');

    // Past the hour mark the same row the needs-you strip calls urgent
    // lists 'high' here; an unknown repo falls back to the job id in the title.
    const old = items.find(i => i.id === 'stuck-fixes:FIXUP-MAIN-ashlrai-website-def5678')!;
    expect(old).toMatchObject({ severity: 'high', title: 'unknown repo fix PR stuck 130 min' });
  });

  it('reports missing and unavailable honestly and never lists seam rows under them', async () => {
    const missing = await readFixes(fixesRead({ state: 'missing', stuck: [stuckFix()] }));
    expect(missing.sources['stuck-fixes']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'stuck-fixes')).toHaveLength(0);

    const unavailable = await readFixes(fixesRead({ state: 'unavailable', stuck: [stuckFix()] }));
    expect(unavailable.sources['stuck-fixes']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'stuck-fixes')).toHaveLength(0);

    const throwing = await read({ readStuckFixes: async () => { throw new Error('ledger boom'); } });
    expect(throwing.sources['stuck-fixes']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'stuck-fixes')).toHaveLength(0);

    // A degraded read still lists what it found, pending counted.
    const degraded = await readFixes(fixesRead({ state: 'degraded', stuck: [stuckFix()] }));
    expect(degraded.sources['stuck-fixes']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'stuck-fixes')).toHaveLength(1);
  });

  it('reads the real metrics/jobs.jsonl under runsDir: stuck, terminal, fresh and non-fix rows', async () => {
    mkdirSync(join(runsDir, 'metrics'), { recursive: true, mode: 0o700 });
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), [
      // Stuck: PR published 45m ago, no terminal row.
      JSON.stringify({ job: 'FIXUP-MAIN-ashlrai-phantom-abc1234', repo: 'ashlrai/phantom',
        url: 'https://github.com/ashlrai/phantom/pull/4242', ts: iso(45 * 60_000) }),
      // Terminal: a MERGED row for the same job — never stuck.
      JSON.stringify({ job: 'FIXUP-MAIN-ashlrai-phantom-merged99', state: 'MERGED',
        url: 'https://github.com/ashlrai/phantom/pull/9', ts: iso(50 * 60_000) }),
      // Fresh: PR published 10m ago — inside the 20-minute bound.
      JSON.stringify({ job: 'FIXUP-MAIN-ashlrai-phantom-fresh11',
        url: 'https://github.com/ashlrai/phantom/pull/10', ts: iso(10 * 60_000) }),
      // Not a fix job: ordinary job ids never list.
      JSON.stringify({ job: 'RQ-OTHER-1', url: 'https://github.com/ashlrai/phantom/pull/11', ts: iso(90 * 60_000) }),
      // Torn line: skipped by the fold, never fatal.
      '{not json',
    ].join('\n'), { mode: 0o600 });

    const inbox = await read();
    expect(inbox.sources['stuck-fixes']).toEqual({ state: 'healthy', pending: 1 });
    const items = inbox.items.filter(i => i.source === 'stuck-fixes');
    expect(items.map(i => i.id)).toEqual(['stuck-fixes:FIXUP-MAIN-ashlrai-phantom-abc1234']);
    expect(items[0]).toMatchObject({ kind: 'stuck-fix', severity: 'warn', jobIds: ['FIXUP-MAIN-ashlrai-phantom-abc1234'] });
    expect(items[0]!.since).toBe(iso(45 * 60_000));
  });

  it('reports a missing ledger as missing and an unlistable one as unavailable', async () => {
    // No metrics/jobs.jsonl at all — verified-absent, no fix PR can be on record.
    const missing = await read();
    expect(missing.sources['stuck-fixes']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'stuck-fixes')).toHaveLength(0);

    // A directory where the ledger belongs is a read failure, not verified-empty.
    mkdirSync(join(runsDir, 'metrics', 'jobs.jsonl'), { recursive: true });
    const unavailable = await read();
    expect(unavailable.sources['stuck-fixes']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'stuck-fixes')).toHaveLength(0);
  });

  it('narrows under --source, --kind and --job like every other source', async () => {
    const pending = fixesRead({ stuck: [stuckFix(), stuckFix({ job: 'FIXUP-MAIN-ashlrai-phantom-zzz9999' })] });
    const bySource = await readFixes(pending, { filter: { source: 'stuck-fixes' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'stuck-fixes')).toBe(true);
    const byKind = await readFixes(pending, { filter: { kind: 'stuck-fix' } });
    expect(byKind.items).toHaveLength(2);
    expect(byKind.sources['stuck-fixes']).toEqual({ state: 'healthy', pending: 2 });
    // The FIXUP-MAIN job id is the item's own citation — --job names it directly.
    const byJob = await readFixes(pending, { filter: { job: 'FIXUP-MAIN-ashlrai-phantom-zzz9999' } });
    expect(byJob.items.filter(i => i.source === 'stuck-fixes').map(i => i.id))
      .toEqual(['stuck-fixes:FIXUP-MAIN-ashlrai-phantom-zzz9999']);
  });
});

describe('readUnifiedInbox stranded work', () => {
  const strandedRead = (over: Partial<StrandedWorkSourceRead> = {}): StrandedWorkSourceRead => ({
    state: 'healthy', items: [], ...over,
  });
  const readStranded = (s: StrandedWorkSourceRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readStrandedWork: async () => s, ...extra });
  const stranded = (over: Partial<StrandedItem> = {}): StrandedItem => ({
    job: 'RQ-STRAND-1', repo: 'ashlrai/phantom', lane: 'fast',
    finished_at: new Date(now - 2 * 3_600_000).toISOString(),
    diff_files: 3, diff_lines: 120,
    cause: 'abort_other', pushed_branch: null, recovered_by: null, verify: null,
    next_step: 'Re-run the job: the publish stopped before any branch was pushed.', ...over,
  });

  it('lists each unrecovered stranded worktree as a warn naming job, repo, lane, cause, size and acts', async () => {
    const inbox = await readStranded(strandedRead({ items: [
      stranded(),
      stranded({ job: 'RQ-STRAND-2', cause: 'abort_after_push',
        pushed_branch: 'codex-bridge/RQ-STRAND-2',
        next_step: 'Recover the pushed branch codex-bridge/RQ-STRAND-2: run phm fleet republish for the ready-made recovery job.' }),
    ] }));
    expect(inbox.sources['stranded-work']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'stranded-work');
    expect(items).toHaveLength(2);

    const first = items.find(i => i.id === 'stranded-work:RQ-STRAND-1')!;
    expect(first).toMatchObject({
      kind: 'stranded-worktree', severity: 'warn', blocking: false,
      title: 'Job RQ-STRAND-1 finished with changes but no pull request',
      since: new Date(now - 2 * 3_600_000).toISOString(), expiresAt: null,
      jobIds: ['RQ-STRAND-1'],
      act: ['phm fleet stranded', 'phm fleet kept-worktrees'],
    });
    expect(first.detail).toContain('ashlrai/phantom');
    expect(first.detail).toContain('fast lane');
    expect(first.detail).toContain('abort other');
    expect(first.detail).toContain('3 files, 120 lines');
    expect(first.detail).toContain('Re-run the job');

    // A pushed-branch abort adds the republish act — the recovery path
    // `phm fleet stranded`'s own next step names.
    const pushed = items.find(i => i.id === 'stranded-work:RQ-STRAND-2')!;
    expect(pushed.act).toEqual(['phm fleet stranded', 'phm fleet republish', 'phm fleet kept-worktrees']);
    expect(pushed.detail).toContain('abort after push');
  });

  it('never lists rows a later job recovered or a verify proved on main', async () => {
    const inbox = await readStranded(strandedRead({ items: [
      stranded(),
      stranded({ job: 'RQ-STRAND-DONE', recovered_by: 'RQ-RECOVERY-9',
        next_step: 'Nothing to do: RQ-RECOVERY-9 recovered this work.' }),
      stranded({ job: 'RQ-STRAND-MAIN', verify: 'already_on_main',
        next_step: 'Nothing to do: this work is already on the main branch.' }),
    ] }));
    expect(inbox.sources['stranded-work']).toEqual({ state: 'healthy', pending: 1 });
    expect(inbox.items.filter(i => i.source === 'stranded-work').map(i => i.id))
      .toEqual(['stranded-work:RQ-STRAND-1']);
  });

  it('reports missing and unavailable honestly and never lists seam rows under them', async () => {
    const missing = await readStranded(strandedRead({ state: 'missing', items: [stranded()] }));
    expect(missing.sources['stranded-work']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'stranded-work')).toHaveLength(0);

    const unavailable = await readStranded(strandedRead({ state: 'unavailable', items: [stranded()] }));
    expect(unavailable.sources['stranded-work']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'stranded-work')).toHaveLength(0);

    const throwing = await read({ readStrandedWork: async () => { throw new Error('kept list boom'); } });
    expect(throwing.sources['stranded-work']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'stranded-work')).toHaveLength(0);

    // A degraded read still lists what it found, pending counted.
    const degraded = await readStranded(strandedRead({ state: 'degraded', items: [stranded()] }));
    expect(degraded.sources['stranded-work']).toEqual({ state: 'degraded', pending: 1 });
    expect(degraded.items.filter(i => i.source === 'stranded-work')).toHaveLength(1);
  });

  it('reads the real kept-worktree fold under runsDir: stranded, made, recovered and out-of-window rows', async () => {
    mkdirSync(join(runsDir, 'queue', 'run'), { recursive: true });
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const hint = (job: string) => `remote:      https://github.com/someone/phantom/pull/new/codex-bridge/${job}\n`;
    // Kept worktrees: two stranded, one published PR (made — never lists),
    // one recovered by a later job's queue line (nothing left to do), one
    // finished outside the 3-day window (stale — never lists).
    writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({
      lanes: { claude: { running: 1 } },
      kept_worktrees: ['RQ-STRAND-A', 'RQ-STRAND-B', 'RQ-PR-1', 'RQ-RECOVERED', 'RQ-OLD'],
    }));
    const row = (job: string, fields: object, msAgo: number) =>
      JSON.stringify({ job, lane: 'claude', ts: iso(msAgo), ...fields });
    writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), [
      row('RQ-STRAND-A', { event: 'finish', diff_files: 3, diff_lines: 50, empty: false }, 2 * 3_600_000),
      row('RQ-STRAND-B', { event: 'finish', diff_files: 1, diff_lines: 8, empty: false }, 5 * 3_600_000),
      row('RQ-PR-1', { event: 'finish', diff_files: 2, diff_lines: 9, empty: false }, 3 * 3_600_000),
      row('RQ-RECOVERED', { event: 'finish', diff_files: 4, diff_lines: 40, empty: false }, 4 * 3_600_000),
      row('RQ-OLD', { event: 'finish', diff_files: 9, diff_lines: 90, empty: false }, 10 * 24 * 3_600_000),
      'not json',
    ].join('\n'));
    for (const job of ['RQ-STRAND-A', 'RQ-STRAND-B', 'RQ-PR-1', 'RQ-RECOVERED']) {
      writeFileSync(join(runsDir, 'queue', 'run', `${job}.line`), `${job}\tphantom\tclaude\twork\n`);
    }
    // The recovery job's own line names RQ-RECOVERED and says recover —
    // the same evidence `recoveredBy` folds, so the row lists as done.
    writeFileSync(join(runsDir, 'queue', 'run', 'RQ-RECOVERY-1.line'),
      'RQ-RECOVERY-1\tphantom\tclaude\tRecover the stranded work of RQ-RECOVERED.\n');
    writeFileSync(join(runsDir, 'RQ-STRAND-A.publish'), 'NOTE scoped\nRESULT ABORT commit\n');
    writeFileSync(join(runsDir, 'RQ-STRAND-B.publish'), `${hint('RQ-STRAND-B')}RESULT ABORT default-fetch\n`);
    writeFileSync(join(runsDir, 'RQ-PR-1.publish'), 'RESULT PR https://github.com/ashlrai/phantom/pull/2 SENS=[]\n');
    writeFileSync(join(runsDir, 'RQ-RECOVERED.publish'), 'RESULT ABORT commit\n');
    writeFileSync(join(runsDir, 'RQ-OLD.publish'), 'RESULT ABORT commit\n');

    const inbox = await read();
    expect(inbox.sources['stranded-work']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'stranded-work');
    expect(items.map(i => i.id).sort()).toEqual(['stranded-work:RQ-STRAND-A', 'stranded-work:RQ-STRAND-B']);
    const abort = items.find(i => i.id === 'stranded-work:RQ-STRAND-A')!;
    expect(abort).toMatchObject({
      kind: 'stranded-worktree', severity: 'warn',
      since: iso(2 * 3_600_000), expiresAt: null, jobIds: ['RQ-STRAND-A'],
      act: ['phm fleet stranded', 'phm fleet kept-worktrees'],
    });
    expect(abort.detail).toContain('phantom · claude lane · abort other · 3 files, 50 lines');
    const pushed = items.find(i => i.id === 'stranded-work:RQ-STRAND-B')!;
    expect(pushed.act).toEqual(['phm fleet stranded', 'phm fleet republish', 'phm fleet kept-worktrees']);
    expect(pushed.detail).toContain('abort after push');
  });

  it('reports a missing status.json as missing and an unlistable one as unavailable', async () => {
    // No queue/status.json at all — verified-absent, no kept worktree can be listed.
    const missing = await read();
    expect(missing.sources['stranded-work']).toEqual({ state: 'missing', pending: 0 });
    expect(missing.items.filter(i => i.source === 'stranded-work')).toHaveLength(0);

    // A directory where the kept list belongs is a read failure, not verified-empty.
    mkdirSync(join(runsDir, 'queue', 'status.json'), { recursive: true });
    const unavailable = await read();
    expect(unavailable.sources['stranded-work']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'stranded-work')).toHaveLength(0);
  });

  it('narrows under --source, --kind and --job like every other source', async () => {
    const pending = strandedRead({ items: [stranded(), stranded({ job: 'RQ-STRAND-2' })] });
    const bySource = await readStranded(pending, { filter: { source: 'stranded-work' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'stranded-work')).toBe(true);
    const byKind = await readStranded(pending, { filter: { kind: 'stranded-worktree' } });
    expect(byKind.items).toHaveLength(2);
    expect(byKind.sources['stranded-work']).toEqual({ state: 'healthy', pending: 2 });
    // The job id is the item's own citation — --job names it directly.
    const byJob = await readStranded(pending, { filter: { job: 'RQ-STRAND-2' } });
    expect(byJob.items.filter(i => i.source === 'stranded-work').map(i => i.id))
      .toEqual(['stranded-work:RQ-STRAND-2']);
  });
});

describe('readUnifiedInbox dispatch stuck', () => {
  const stuckRead = (over: Partial<DispatchStuckSourceRead> = {}): DispatchStuckSourceRead => ({
    state: 'healthy', jobs: [], ...over,
  });
  const readStuck = (s: DispatchStuckSourceRead, extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readDispatchStuck: async () => s, ...extra });
  const stuckJob = (over: Partial<DispatchStuckJob> = {}): DispatchStuckJob => ({
    job: 'RQ-STUCK-1', lane: 'devin', cause: 'lane_refused_size', events: 3,
    firstSeen: new Date(now - 2 * 3_600_000).toISOString(),
    lastSeen: new Date(now - 10 * 60_000).toISOString(),
    ageSeconds: 7_200,
    action: 'move to a lane that accepts this size',
    kind: 'DEVIN_FLASH_REFUSED', reason: 'size-not-sm', ...over,
  });
  // Log lines carry the local wall clock, so stamps are built the same way.
  const localStamp = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const eventLine = (ms: number, rest: string) => `${localStamp(ms)} ${rest}`;

  it('lists each stuck job as a warn naming job, lane, cause, events and acts', async () => {
    const inbox = await readStuck(stuckRead({ jobs: [
      stuckJob(),
      stuckJob({ job: 'RQ-STUCK-2', lane: null, cause: 'lane_refused_repo',
        action: 'move to a lane that accepts this repo',
        kind: 'DEVIN_FLASH_REFUSED', reason: 'repo-not-eligible' }),
      stuckJob({ job: 'RQ-STUCK-3', lane: 'claude', cause: 'worktree_cleanup_failed',
        action: 'worktree cleanup keeps failing; needs a manual look',
        kind: 'WT_ORPHAN_REMOVE_FAILED', reason: '(RuntimeError)' }),
      stuckJob({ job: 'RQ-STUCK-4', lane: null, cause: 'unknown',
        action: 'cause not recognised; read the event log lines for this job',
        kind: 'PUBLISH_FAILED', reason: 'exit 3' }),
    ] }));
    expect(inbox.sources['dispatch-stuck']).toEqual({ state: 'healthy', pending: 4 });
    const items = inbox.items.filter(i => i.source === 'dispatch-stuck');
    expect(items).toHaveLength(4);

    const refused = items.find(i => i.id === 'dispatch-stuck:RQ-STUCK-1')!;
    expect(refused).toMatchObject({
      kind: 'dispatch-stuck', severity: 'warn', blocking: false,
      title: 'Job RQ-STUCK-1 cannot launch — dispatch keeps refusing it',
      since: new Date(now - 2 * 3_600_000).toISOString(), expiresAt: null,
      jobIds: ['RQ-STUCK-1'],
      act: ['phm fleet stuck', 'phm queue lane RQ-STUCK-1 <lane>', 'phm queue'],
    });
    expect(refused.detail).toContain('lane devin');
    expect(refused.detail).toContain('waiting 2h');
    expect(refused.detail).toContain('3 events');
    expect(refused.detail).toContain('DEVIN_FLASH_REFUSED size-not-sm');
    expect(refused.detail).toContain('move to a lane that accepts this size');

    // A lane refusal with no ready-list lane falls back to the refusing
    // lane or unknown — here the read handed null, so the detail says so.
    const noLane = items.find(i => i.id === 'dispatch-stuck:RQ-STUCK-2')!;
    expect(noLane.detail).toContain('lane unknown');
    expect(noLane.act).toEqual(['phm fleet stuck', 'phm queue lane RQ-STUCK-2 <lane>', 'phm queue']);

    // A *_FAILED kind is a failure, not a refusal — the title and acts
    // follow the cause, never a guessed verdict.
    const cleanup = items.find(i => i.id === 'dispatch-stuck:RQ-STUCK-3')!;
    expect(cleanup.title).toBe('Job RQ-STUCK-3 cannot launch — dispatch keeps failing it');
    expect(cleanup.act).toEqual(['phm fleet stuck', 'phm fleet worktrees', 'phm queue']);
    expect(cleanup.detail).toContain('WT_ORPHAN_REMOVE_FAILED (RuntimeError)');

    const unknown = items.find(i => i.id === 'dispatch-stuck:RQ-STUCK-4')!;
    expect(unknown.act).toEqual(['phm fleet stuck', 'phm fleet dispatch-events', 'phm queue']);
    expect(unknown.detail).toContain('cause not recognised');
  });

  it('reports unavailable honestly and never lists seam rows under it', async () => {
    // `phm fleet stuck`'s own rule: a missing or unreadable event log
    // leaves the stuck set unknown — never an empty list passed off as
    // fact — so 'missing' cannot appear here at all.
    const unavailable = await readStuck(stuckRead({ state: 'unavailable', jobs: [stuckJob()] }));
    expect(unavailable.sources['dispatch-stuck']).toEqual({ state: 'unavailable', pending: null });
    expect(unavailable.items.filter(i => i.source === 'dispatch-stuck')).toHaveLength(0);

    const throwing = await read({ readDispatchStuck: async () => { throw new Error('events boom'); } });
    expect(throwing.sources['dispatch-stuck']).toEqual({ state: 'unavailable', pending: null });
    expect(throwing.items.filter(i => i.source === 'dispatch-stuck')).toHaveLength(0);

    // A degraded ready read still lists every event-proven job — the
    // events log, not the ready list, proves the stuck set — with the
    // lane-attribution caveat in the detail.
    const degraded = await readStuck(stuckRead({ state: 'degraded', jobs: [stuckJob()] }));
    expect(degraded.sources['dispatch-stuck']).toEqual({ state: 'degraded', pending: 1 });
    const item = degraded.items.find(i => i.source === 'dispatch-stuck')!;
    expect(item.detail).toContain('ready.tsv read degraded');
  });

  it('reads the real dispatch-events.log and ready.tsv under runsDir', async () => {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    const t = (msAgo: number) => now - msAgo;
    writeFileSync(join(runsDir, 'queue', 'dispatch-events.log'), [
      // Stuck: two refusals since the last launch, still active.
      eventLine(t(2 * 3_600_000), 'DEVIN_FLASH_REFUSED RQ-STUCK-A size-not-sm'),
      eventLine(t(2 * 3_600_000 - 5 * 60_000), 'DEVIN_FLASH_REFUSED RQ-STUCK-A size-not-sm'),
      eventLine(t(2 * 3_600_000 - 10 * 60_000), 'DEVIN_FLASH_REFUSED RQ-STUCK-A size-not-sm'),
      // Stuck: a worktree cleanup failure — lane falls back to unknown.
      eventLine(t(2 * 3_600_000), 'WT_ORPHAN_REMOVE_FAILED RQ-STUCK-B (RuntimeError)'),
      eventLine(t(2 * 3_600_000 - 5 * 60_000), 'WT_ORPHAN_REMOVE_FAILED RQ-STUCK-B (RuntimeError)'),
      // Refused once, then launched — the LAUNCH clears it, never lists.
      eventLine(t(4 * 3_600_000), 'DEVIN_FLASH_REFUSED RQ-LAUNCHED-1 size-not-sm'),
      eventLine(t(4 * 3_600_000 - 2 * 60_000), 'LAUNCH RQ-LAUNCHED-1 phantom claude frontier'),
      // Refused but gone quiet for over an hour — fixed or removed.
      eventLine(t(5 * 3_600_000), 'DEVIN_FLASH_REFUSED RQ-QUIET-1 size-not-sm'),
      eventLine(t(5 * 3_600_000 - 5 * 60_000), 'DEVIN_FLASH_REFUSED RQ-QUIET-1 size-not-sm'),
      eventLine(t(90 * 60_000), 'TICK ok'),
      'not a log line',
    ].join('\n') + '\n', { mode: 0o600 });
    // The ready list names RQ-STUCK-A's lane — it wins over the refusing
    // lane the event kind would imply.
    writeFileSync(join(runsDir, 'queue', 'ready.tsv'),
      'RQ-STUCK-A\tcodex-local\n', { mode: 0o600 });

    const inbox = await read();
    expect(inbox.sources['dispatch-stuck']).toEqual({ state: 'healthy', pending: 2 });
    const items = inbox.items.filter(i => i.source === 'dispatch-stuck');
    expect(items.map(i => i.id).sort()).toEqual(['dispatch-stuck:RQ-STUCK-A', 'dispatch-stuck:RQ-STUCK-B']);
    const lane = items.find(i => i.id === 'dispatch-stuck:RQ-STUCK-A')!;
    expect(lane).toMatchObject({
      kind: 'dispatch-stuck', severity: 'warn', jobIds: ['RQ-STUCK-A'],
      act: ['phm fleet stuck', 'phm queue lane RQ-STUCK-A <lane>', 'phm queue'],
    });
    expect(lane.detail).toContain('lane codex-local');
    expect(lane.detail).toContain('DEVIN_FLASH_REFUSED size-not-sm');
    const cleanup = items.find(i => i.id === 'dispatch-stuck:RQ-STUCK-B')!;
    expect(cleanup.act).toEqual(['phm fleet stuck', 'phm fleet worktrees', 'phm queue']);
    expect(cleanup.detail).toContain('lane unknown');
  });

  it('reports a missing or unreadable event log as unavailable — unknown, never an empty list', async () => {
    // No dispatch-events.log anywhere under runsDir — `phm fleet stuck`
    // itself reports unknown (exit 1), so the source can never claim a
    // verified-empty stuck set.
    const missing = await read();
    expect(missing.sources['dispatch-stuck']).toEqual({ state: 'unavailable', pending: null });
    expect(missing.items.filter(i => i.source === 'dispatch-stuck')).toHaveLength(0);

    // A directory where the log belongs is a degraded read — still
    // unknown, never verified-empty.
    mkdirSync(join(runsDir, 'queue', 'dispatch-events.log'), { recursive: true });
    const degraded = await read();
    expect(degraded.sources['dispatch-stuck']).toEqual({ state: 'unavailable', pending: null });
    expect(degraded.items.filter(i => i.source === 'dispatch-stuck')).toHaveLength(0);
  });

  it('narrows under --source, --kind and --job like every other source', async () => {
    const pending = stuckRead({ jobs: [stuckJob(), stuckJob({ job: 'RQ-STUCK-2' })] });
    const bySource = await readStuck(pending, { filter: { source: 'dispatch-stuck' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'dispatch-stuck')).toBe(true);
    const byKind = await readStuck(pending, { filter: { kind: 'dispatch-stuck' } });
    expect(byKind.items).toHaveLength(2);
    expect(byKind.sources['dispatch-stuck']).toEqual({ state: 'healthy', pending: 2 });
    // The job id is the item's own citation — --job names it directly.
    const byJob = await readStuck(pending, { filter: { job: 'RQ-STUCK-2' } });
    expect(byJob.items.filter(i => i.source === 'dispatch-stuck').map(i => i.id))
      .toEqual(['dispatch-stuck:RQ-STUCK-2']);
  });
});

describe('readUnifiedInbox channel health', () => {
  const bridge = (channel: 'slack' | 'imessage', over: Partial<ChannelHealth> = {}): ChannelHealth => ({
    channel, configured: true, processAlive: true, runtimeHost: 'test-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    state: 'LIVE', missing: [], asOf: new Date(now).toISOString(),
    ...over,
  });
  const bridges = (slack: ChannelHealth, imessage: ChannelHealth = bridge('imessage')): ChannelHealthReport => ({
    schemaVersion: 1, asOf: new Date(now).toISOString(), channels: [slack, imessage],
  });
  const liveBridges = () => bridges(bridge('slack'), bridge('imessage'));
  const telegramCfg = { comms: { channel: 'telegram', enabled: true, telegram: { botToken: 'x', chatId: '12345' } } } as AshlrConfig;
  // `now` is only assigned in beforeEach — build poll fixtures lazily.
  const pollOk = () => ({
    lastPoll: new Date(now - 60_000).toISOString(), lastSuccess: new Date(now - 120_000).toISOString(),
    error: null, pollerAlive: true, lastUpdateId: 41, tokenPresent: true, leaderTick: 'completed' as const,
  });
  const readHealth = (report: ChannelHealthReport | (() => Promise<ChannelHealthReport>), extra: Partial<UnifiedInboxOptions> = {}) =>
    read({
      readChannelHealth: typeof report === 'function' ? report : async () => report,
      readChannelConfig: () => ({}) as AshlrConfig,
      ...extra,
    });

  it('reports healthy with a real zero under the default reads — unconfigured channels are setup state, not pending work', async () => {
    const inbox = await read();
    expect(inbox.sources['channel-health']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'channel-health')).toHaveLength(0);
  });

  it('never lists LIVE bridges or BLOCKED-unconfigured (not-set-up) channels', async () => {
    const inbox = await readHealth(bridges(
      bridge('slack', { state: 'BLOCKED', configured: false, processAlive: false, missing: ['slack agent-network config not configured'] }),
      bridge('imessage', { state: 'BLOCKED', configured: false, processAlive: 'unknown', missing: ['imessage comms configuration not configured'] }),
    ));
    expect(inbox.sources['channel-health']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'channel-health')).toHaveLength(0);
  });

  it('lists a configured bridge whose process is gone as a high channel-blocked item', async () => {
    const inbox = await readHealth(bridges(
      bridge('slack', { state: 'BLOCKED', processAlive: false, missing: ['slack bridge process not running'] }),
    ));
    expect(inbox.sources['channel-health']).toEqual({ state: 'healthy', pending: 1 });
    const item = inbox.items.find(i => i.id === 'channel-health:slack')!;
    expect(item).toMatchObject({
      source: 'channel-health', kind: 'channel-blocked', severity: 'high', blocking: false,
      title: 'Slack channel blocked', since: null, expiresAt: null,
      act: ['phm fleet channel-health', 'phm channels slack status', 'phm channels'],
    });
    expect(item.detail).toContain('slack bridge process not running');
    expect(item.jobIds).toBeUndefined();
  });

  it('lists a degraded bridge as warn, carrying its reasons and the unanswered count', async () => {
    const inbox = await readHealth(bridges(
      bridge('imessage', {
        state: 'DEGRADED', unansweredCount: 2,
        missing: ['imessage reply correlation unavailable', 'imessage outbound send failed'],
      }),
    ));
    const item = inbox.items.find(i => i.id === 'channel-health:imessage')!;
    expect(item).toMatchObject({
      kind: 'channel-degraded', severity: 'warn', title: 'iMessage channel degraded',
      act: ['phm fleet channel-health', 'phm imessage doctor', 'phm channels'],
    });
    expect(item.detail).toContain('imessage reply correlation unavailable');
    expect(item.detail).toContain('imessage outbound send failed');
    expect(item.detail).toContain('2 inbound requests unanswered');
  });

  it('says why a degraded bridge degraded when the reason list is empty', async () => {
    const inbox = await readHealth(bridges(
      bridge('slack', { state: 'DEGRADED', unansweredCount: 1, missing: [] }),
    ));
    const item = inbox.items.find(i => i.id === 'channel-health:slack')!;
    expect(item.detail).toBe('1 inbound request unanswered past the reply grace');
  });

  it('lists an UNKNOWN bridge — including unreadable config — as warn, never as verified-empty', async () => {
    const inbox = await readHealth(bridges(
      bridge('slack', { state: 'UNKNOWN', configured: false, processAlive: 'unknown', missing: ['slack configuration unreadable'] }),
      bridge('imessage', { state: 'UNKNOWN', missing: ['imessage receipt source unreadable'] }),
    ));
    expect(inbox.sources['channel-health']).toEqual({ state: 'healthy', pending: 2 });
    const slack = inbox.items.find(i => i.id === 'channel-health:slack')!;
    expect(slack).toMatchObject({ kind: 'channel-unknown', severity: 'warn', title: 'Slack channel state unknown' });
    expect(slack.detail).toContain('slack configuration unreadable');
    expect(inbox.items.find(i => i.id === 'channel-health:imessage')).toMatchObject({ kind: 'channel-unknown', severity: 'warn' });
  });

  it('lists a stale telegram poller as one degraded item naming each failed check', async () => {
    const inbox = await read({
      readChannelHealth: async () => liveBridges(),
      readChannelConfig: () => telegramCfg,
      readTelegramPoll: () => ({
        ...pollOk(), pollerAlive: false, error: 'poll failed; inspect value-free poll log',
        lastPoll: new Date(now - 30 * 60_000).toISOString(),
      }),
    });
    expect(inbox.sources['channel-health']).toEqual({ state: 'healthy', pending: 1 });
    const item = inbox.items.find(i => i.id === 'channel-health:telegram')!;
    expect(item).toMatchObject({
      kind: 'channel-degraded', severity: 'warn', title: 'Telegram channel degraded',
      since: null, expiresAt: null,
      act: ['phm comms health --json', 'phm comms cycle', 'phm channels'],
    });
    expect(item.detail).toContain('last recorded poll failed');
    expect(item.detail).toContain('no poll within the last 7 minutes');
    expect(item.detail).toContain(new Date(now - 30 * 60_000).toISOString());
  });

  it('keeps a never-polled telegram honest: no recorded start, no invented since', async () => {
    const inbox = await read({
      readChannelHealth: async () => liveBridges(),
      readChannelConfig: () => telegramCfg,
      readTelegramPoll: () => ({ ...pollOk(), lastPoll: null, lastSuccess: null, pollerAlive: false }),
    });
    const item = inbox.items.find(i => i.id === 'channel-health:telegram')!;
    expect(item.since).toBeNull();
    expect(item.detail).toContain('no poll recorded — the comms cycle has never run');
    expect(item.detail).toContain('no successful poll recorded');
    expect(item.detail).not.toContain('last recorded poll failed');
  });

  it('lists nothing for telegram when the channel is not enabled, and never consults the poll read', async () => {
    const poll = vi.fn(() => pollOk());
    const inbox = await read({
      readChannelHealth: async () => liveBridges(),
      readChannelConfig: () => ({}) as AshlrConfig,
      readTelegramPoll: poll,
    });
    expect(inbox.sources['channel-health']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'channel-health')).toHaveLength(0);
    expect(poll).not.toHaveBeenCalled();
  });

  it('reports an unreadable main config as a degraded source with a telegram channel-unknown item', async () => {
    const inbox = await read({
      readChannelHealth: async () => liveBridges(),
      readChannelConfig: () => { throw new Error('config boom'); },
    });
    expect(inbox.sources['channel-health']).toEqual({ state: 'degraded', pending: 1 });
    const item = inbox.items.find(i => i.id === 'channel-health:telegram')!;
    expect(item).toMatchObject({ kind: 'channel-unknown', severity: 'warn', title: 'Telegram channel state unknown' });
    expect(item.detail).toContain('config could not be read');
  });

  it('reports a throwing poll read as channel-unknown and a throwing bridge read as degraded-or-unavailable', async () => {
    const pollThrow = await read({
      readChannelHealth: async () => liveBridges(),
      readChannelConfig: () => telegramCfg,
      readTelegramPoll: () => { throw new Error('poll boom'); },
    });
    expect(pollThrow.sources['channel-health']).toEqual({ state: 'degraded', pending: 1 });
    expect(pollThrow.items.find(i => i.id === 'channel-health:telegram')).toMatchObject({ kind: 'channel-unknown', severity: 'warn' });

    const bridgesOnly = await read({
      readChannelHealth: async () => { throw new Error('health boom'); },
      readChannelConfig: () => telegramCfg,
      readTelegramPoll: () => ({ ...pollOk(), pollerAlive: false, lastPoll: null, lastSuccess: null }),
    });
    // The bridge leg is unreadable but the telegram verdict still lists —
    // degraded, never unavailable, because one leg proved pending work.
    expect(bridgesOnly.sources['channel-health']).toEqual({ state: 'degraded', pending: 1 });
    expect(bridgesOnly.items.filter(i => i.source === 'channel-health').map(i => i.id)).toEqual(['channel-health:telegram']);

    const both = await read({
      readChannelHealth: async () => { throw new Error('health boom'); },
      readChannelConfig: () => { throw new Error('config boom'); },
    });
    // Both legs failed: degraded with the telegram-unknown verdict still
    // listed — a throwing config read IS the unknown evidence, and
    // 'unavailable' never applies to a live probe that always resolves.
    expect(both.sources['channel-health']).toEqual({ state: 'degraded', pending: 1 });
    expect(both.items.filter(i => i.source === 'channel-health').map(i => i.id)).toEqual(['channel-health:telegram']);
  });

  it('narrows under --source, --kind and --job like every other source', async () => {
    const degraded = async () => bridges(
      bridge('slack', { state: 'BLOCKED', processAlive: false, missing: ['slack bridge process not running'] }),
      bridge('imessage', { state: 'DEGRADED', unansweredCount: 1, missing: [] }));
    const bySource = await readHealth(degraded, { filter: { source: 'channel-health' } });
    expect(bySource.items).toHaveLength(2);
    expect(bySource.items.every(i => i.source === 'channel-health')).toBe(true);
    expect(bySource.sources['channel-health']).toEqual({ state: 'healthy', pending: 2 });
    const byKind = await read({
      readChannelHealth: async () => degraded(),
      readChannelConfig: () => ({}) as AshlrConfig,
      filter: { kind: 'channel-blocked' },
    });
    expect(byKind.items.filter(i => i.source === 'channel-health').map(i => i.id)).toEqual(['channel-health:slack']);
    // A channel verdict names no job — --job never matches it.
    const byJob = await read({
      readChannelHealth: async () => degraded(),
      readChannelConfig: () => ({}) as AshlrConfig,
      filter: { job: 'job-1' },
    });
    expect(byJob.items.filter(i => i.source === 'channel-health')).toHaveLength(0);
  });
});

describe('readUnifiedInbox owner pair', () => {
  type PairRead = NonNullable<UnifiedInboxOptions['readOwnerPair']>;
  const pairOk = (pending: { sent: number; startedAt: number; expiresAt: number } | null, paired = false) =>
    (): ReturnType<PairRead> => ({ status: 'ok', pending, paired });
  // `now` is assigned in beforeEach — build the pending record lazily so its
  // stamps are real epoch ms, not NaN from an undefined `now` at module load.
  const livePending = () => ({ sent: 2, startedAt: now - 3_600_000, expiresAt: now + 20 * 3_600_000 });
  const readPair = (readOwnerPair: UnifiedInboxOptions['readOwnerPair'], extra: Partial<UnifiedInboxOptions> = {}) =>
    read({ readOwnerPair, ...extra });

  it('lists a live pairing wait as a warn item with its real send and YES-window deadline', async () => {
    const pending = livePending();
    const inbox = await readPair(pairOk(pending));
    expect(inbox.sources['owner-pair']).toEqual({ state: 'healthy', pending: 1 });
    const item = inbox.items.find(i => i.id === 'owner-pair:pending')!;
    expect(item).toMatchObject({
      source: 'owner-pair', kind: 'owner-pair-waiting', severity: 'warn', blocking: false,
      title: 'iMessage owner pairing waiting for YES',
      since: new Date(pending.startedAt).toISOString(),
      expiresAt: new Date(pending.expiresAt).toISOString(),
      act: ['phm owner pair status --json', 'phm owner pair imessage'],
    });
    expect(item.detail).toContain(`${pending.sent} own handle(s)`);
    expect(item.detail).toContain('answers YES binds');
    expect(item.jobIds).toBeUndefined();
  });

  it('hides an expired wait — the YES window already closed', async () => {
    const inbox = await readPair(pairOk({ sent: 1, startedAt: now - 30 * 3_600_000, expiresAt: now - 3_600_000 }));
    expect(inbox.sources['owner-pair']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'owner-pair')).toHaveLength(0);
  });

  it('hides a leftover pending record once an owner handle is bound', async () => {
    const inbox = await readPair(pairOk(livePending(), true));
    expect(inbox.sources['owner-pair']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'owner-pair')).toHaveLength(0);
  });

  it('reports a verified-absent state file missing and a real zero pending', async () => {
    const inbox = await readPair(() => ({ status: 'missing' }));
    expect(inbox.sources['owner-pair']).toEqual({ state: 'missing', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'owner-pair')).toHaveLength(0);
  });

  it('reports an unreadable or unparseable state file unavailable — never an empty wait', async () => {
    const inbox = await readPair(() => ({ status: 'unavailable' }));
    expect(inbox.sources['owner-pair']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'owner-pair')).toHaveLength(0);
  });

  it('keeps a readable file with no pending record healthy at a real zero', async () => {
    const inbox = await readPair(pairOk(null));
    expect(inbox.sources['owner-pair']).toEqual({ state: 'healthy', pending: 0 });
    expect(inbox.items.filter(i => i.source === 'owner-pair')).toHaveLength(0);
  });

  it('degrades to unavailable when the read throws', async () => {
    const inbox = await read({ readOwnerPair: () => { throw new Error('pair boom'); } });
    expect(inbox.sources['owner-pair']).toEqual({ state: 'unavailable', pending: null });
    expect(inbox.items.filter(i => i.source === 'owner-pair')).toHaveLength(0);
  });

  it('narrows under --source and --kind like every other source', async () => {
    const pending = pairOk(livePending());
    const bySource = await readPair(pending, { filter: { source: 'owner-pair' } });
    expect(bySource.items).toHaveLength(1);
    expect(bySource.items[0]!.source).toBe('owner-pair');
    const byKind = await readPair(pending, { filter: { kind: 'owner-pair-waiting' } });
    expect(byKind.items.map(i => i.id)).toEqual(['owner-pair:pending']);
    // A pair wait names no job — --job never matches it.
    const byJob = await readPair(pending, { filter: { job: 'job-1' } });
    expect(byJob.items.filter(i => i.source === 'owner-pair')).toHaveLength(0);
  });
});
