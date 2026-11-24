import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { readSlackWorkStatus, slackWorkStatusLine } from '../src/core/agents/slack-status.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('renders the exact board evidence and rejects conflicting identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-evidence-')); dirs.push(root);
  const received = Date.parse('2026-01-01T00:00:00Z');
  const channelRef = 'slack:T0TEST:C0TESTCHAN1:1234567890.123456';
  const request: BusEnvelope = { id: 'fake-request', from: 'fake-owner', to: 'leader', priority: 'P1', ttl: 600_000,
    channel: 'slack', channel_ref: channelRef, external: false,
    sender: { agent_id: 'fake-owner', vendor: 'fake', human: true, team: true }, body: { kind: 'note', text: 'status' } };
  expect(appendBusInbox(request, { root, now: () => received }).status).toBe('posted');
  const options = { busRoot: root, runsDir: root, channelRef, now: () => new Date(received + 60_000) };
  let work = readSlackWorkStatus(options);
  let line = slackWorkStatusLine(work, { inReplyTo: request.id });
  expect(line).toContain('as of 2026-01-01T00:00:00.000Z · source receivedAt');
  expect(line).toContain('missing: named owner, durable claim receipt');
  expect(line).not.toContain(work.readAt);
  expect(slackWorkStatusLine(work, { inReplyTo: 'unrelated' })).toMatch(/^UNKNOWN;/);
  expect(slackWorkStatusLine(work, { inReplyTo: request.id, in_reply_to: 'conflict' })).toMatch(/^UNKNOWN;/);
  vi.spyOn(Date, 'now').mockReturnValue(received);
  expect(mutateBusWorkClaim({ action: 'acquire', root, id: request.id, owner: 'fake-worker', leaseMs: 60_000 }).status).toBe('acquired');
  work = readSlackWorkStatus({ ...options, now: () => new Date(received + 31 * 60_000) });
  line = slackWorkStatusLine(work, { inReplyTo: request.id });
  expect(line).toContain('ASSIGNED · fake-worker');
  expect(work.items[0]?.state).toBe('ASSIGNED');
  expect(line).toContain('source claim:bus-claim:fake-request:');
  expect(postBusReply(request.id, 'fake-block', { blocked: { dependency: 'review <@FAKE>\nneeded' } }, { root, now: () => received + 1000 }).outcome).toBe('posted');
  line = slackWorkStatusLine(readSlackWorkStatus(options), { inReplyTo: request.id });
  expect(line).toContain('BLOCKED · fake-worker');
  expect(line).toContain('dependency review ?@FAKE? needed');
  expect(line).not.toMatch(/[\n\r<>&]/);
});

it('retains the legacy snapshot fallback', () => {
  const work = { asOf: null, inbox: 'ok' as const, truncated: false, items: [{ id: 'old', channelRef: null, state: 'RECEIVED' as const, owner: null, claimReceipt: null, pr: null, head: null, dependency: null }] };
  expect(slackWorkStatusLine(work, { inReplyTo: 'old' })).toBe('RECEIVED; owner unknown; claim unknown; fleet as of unknown');
});
