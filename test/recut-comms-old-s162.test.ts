/**
 * RQ-PHX-RECUTCOMMSOLDS162 — recovery regression for original PR #4325
 * (RQ-PHX-DOTREPLYGAP09): teammate reply-gap reading surfaced on the owner
 * comms status. Exercises the real callers with synthetic data on fake
 * hosts only: no real message content, no handles, no credentials, no sends.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordTeammateText, markTeammateTextsAnswered } from '../src/core/comms/imessage-teammate-inbox.js';
import { teammateReplyGap, teammateReplyGapFromInbox, type ReplyGapEvent } from '../src/core/comms/teammate-reply-gap.js';
import { readOwnerCommsStatus, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const min = (n: number) => NOW - n * 60_000;
const ev = (direction: ReplyGapEvent['direction'], at: number): ReplyGapEvent => ({ teammate: 'Ashlr.', direction, at });

const roots: string[] = [];
function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recut-comms-s162-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('teammateReplyGap (recovered pure computation)', () => {
  it('is ok inside the warn window', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(2))], NOW);
    expect(gap).toMatchObject({ teammate: 'Ashlr.', unansweredCount: 1, oldestUnansweredMs: 120_000, state: 'ok' });
  });
  it('is late at 6 minutes and counts every waiting text', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(6)), ev('inbound', min(1))], NOW);
    expect(gap).toMatchObject({ unansweredCount: 2, oldestUnansweredMs: 360_000, state: 'late', lastInboundAt: min(1), lastOutboundAt: null });
  });
  it('clears when an outbound follows the inbound', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(20)), ev('outbound', min(15))], NOW);
    expect(gap).toMatchObject({ unansweredCount: 0, oldestUnansweredMs: 0, state: 'ok', lastOutboundAt: min(15) });
  });
  it('is unknown with no evidence source', () => {
    expect(teammateReplyGap(null, NOW).map(gap => gap.state)).toEqual(['unknown']);
  });
  it('returns metadata only', () => {
    const rows = teammateReplyGap([{ ...ev('inbound', min(9)), body: 'hi', phone: '+15555550100' } as ReplyGapEvent], NOW);
    expect(Object.keys(rows[0]!).sort()).toEqual(['lastInboundAt', 'lastOutboundAt', 'oldestUnansweredMs', 'state', 'teammate', 'unansweredCount']);
    expect(JSON.stringify(rows)).not.toMatch(/\+1555|"hi"|body|phone/);
  });
});

describe('teammateReplyGapFromInbox (recovered inbox reading, fake runsDir)', () => {
  it('reports unknown when the teammate store is absent', () => {
    expect(teammateReplyGapFromInbox(NOW, runsDir()).map(gap => gap.state)).toEqual(['unknown']);
  });
  it('counts unanswered recorded texts as waiting', () => {
    const dir = runsDir();
    expect(recordTeammateText({ rowid: 7, handle: 'teammate-one@example.invalid', text: 'ping?' }, dir, new Date(min(8)))).toBe(true);
    const [gap] = teammateReplyGapFromInbox(NOW, dir);
    expect(gap).toMatchObject({ unansweredCount: 1, oldestUnansweredMs: 8 * 60_000, state: 'late', lastOutboundAt: null });
    expect(JSON.stringify(gap)).not.toMatch(/teammate-one|ping|imessage:/);
  });
  it('marks an answered text as outbound so it no longer waits', () => {
    const dir = runsDir();
    expect(recordTeammateText({ rowid: 9, handle: 'teammate-two@example.invalid', text: 'status?' }, dir, new Date(min(30)))).toBe(true);
    expect(markTeammateTextsAnswered([9], dir, new Date(min(10)))).toBe(1);
    const [gap] = teammateReplyGapFromInbox(NOW, dir);
    expect(gap).toMatchObject({ unansweredCount: 0, state: 'ok', lastInboundAt: min(30), lastOutboundAt: min(30) });
  });
});

describe('readOwnerCommsStatus (recovered wiring + preserved behavior)', () => {
  const options = (dir: string): OwnerThreadOptions => ({
    runsDir: dir, settings: emptyOwnerSettings(), now: () => NOW,
  });

  it('surfaces the reply-gap reading on the owner comms status', () => {
    const dir = runsDir();
    expect(recordTeammateText({ rowid: 3, handle: 'teammate-three@example.invalid', text: 'still waiting?' }, dir, new Date(min(9)))).toBe(true);
    const status = readOwnerCommsStatus(options(dir));
    expect(status.replyGap).toHaveLength(1);
    expect(status.replyGap[0]).toMatchObject({ unansweredCount: 1, oldestUnansweredMs: 9 * 60_000, state: 'late' });
  });
  it('keeps the existing status contract alongside the additive field', () => {
    const dir = runsDir();
    const status = readOwnerCommsStatus(options(dir));
    expect(status).toMatchObject({
      schema: 'comms.owner-thread.status.v1',
      claimKey: 'queue:RQ-COMMS-UNIFIED-1',
      threadId: 'owner',
      kill: false, paused: false, messages: 0,
    });
    expect(Array.isArray(status.adapters)).toBe(true);
    // No teammate store at all → the reading is unknown, never invented ok.
    expect(status.replyGap.map(gap => gap.state)).toEqual(['unknown']);
  });
  it('reflects halt and pause state without touching the gap reading', () => {
    const dir = runsDir();
    const status = readOwnerCommsStatus({ ...options(dir), halted: true });
    expect(status.kill).toBe(true);
    expect(status.replyGap).toHaveLength(1);
    const pausedStatus = readOwnerCommsStatus({ ...options(dir), paused: true });
    expect(pausedStatus.paused).toBe(true);
  });
});
