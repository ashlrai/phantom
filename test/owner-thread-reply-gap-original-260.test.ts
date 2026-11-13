/**
 * RQ-PHX-REPLYGAPORIGINAL260S: reconcile original open PR #4325
 * (RQ-PHX-DOTREPLYGAP09, implementation commit dcf48b2857).
 *
 * Master already carries every original hunk. This suite proves the CURRENT
 * owner-thread reader — `readOwnerCommsStatus` — reports the teammate reply
 * gap end to end: durable teammates.jsonl evidence written by the real ingest
 * (recordTeammateText / markTeammateTextsAnswered) under an isolated runsDir
 * with a fixed clock, asserted on the owner status result rather than the pure
 * teammateReplyGap helper.
 *
 * Reader contract (documented in teammate-reply-gap.ts): an answered marker
 * records no reply time, so an answered text counts as an outbound at its own
 * receipt time — a lower bound that can only under-report lateness. Nothing
 * here sends a message or touches send policy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markTeammateTextsAnswered, recordTeammateText, senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { readOwnerCommsStatus, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const min = (n: number) => NOW - n * 60_000;
const HANDLE = 'fixture-teammate-dot';
const BODY = 'Can you check the merge queue when you get a minute?';

let runsDir: string;
let options: OwnerThreadOptions;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'owner-reply-gap-260-'));
  options = { runsDir, settings: emptyOwnerSettings(), now: () => NOW };
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

describe('readOwnerCommsStatus replyGap (original #4325 reconciliation)', () => {
  it('reports unknown when the teammate evidence source is absent', () => {
    expect(readOwnerCommsStatus(options).replyGap).toEqual([
      { teammate: 'Teammates', lastInboundAt: null, lastOutboundAt: null, unansweredCount: 0, oldestUnansweredMs: 0, state: 'unknown' },
    ]);
  });

  it('keeps a six-minute-old unanswered teammate text late on the owner status result', () => {
    expect(recordTeammateText({ rowid: 7, handle: HANDLE, text: BODY }, runsDir, new Date(min(6)))).toBe(true);
    const status = readOwnerCommsStatus(options);
    expect(status.replyGap).toHaveLength(1);
    expect(status.replyGap[0]).toMatchObject({
      teammate: 'Teammate', unansweredCount: 1, oldestUnansweredMs: 360_000,
      lastInboundAt: min(6), lastOutboundAt: null, state: 'late',
    });
  });

  it('clears the gap once a later durable answer is recorded', () => {
    expect(recordTeammateText({ rowid: 8, handle: HANDLE, text: BODY }, runsDir, new Date(min(20)))).toBe(true);
    expect(readOwnerCommsStatus(options).replyGap[0]).toMatchObject({ unansweredCount: 1, state: 'late' });
    expect(markTeammateTextsAnswered([8], runsDir, new Date(min(15)))).toBe(1);
    expect(readOwnerCommsStatus(options).replyGap[0]).toMatchObject({
      unansweredCount: 0, oldestUnansweredMs: 0, state: 'ok',
      // The reader pins an answered text's outbound at its receipt time.
      lastInboundAt: min(20), lastOutboundAt: min(20),
    });
  });

  it('returns gap metadata only — no message body, sender id or handle', () => {
    expect(recordTeammateText({ rowid: 9, handle: HANDLE, text: BODY }, runsDir, new Date(min(6)))).toBe(true);
    const status = readOwnerCommsStatus(options);
    for (const gap of status.replyGap) {
      expect(Object.keys(gap).sort()).toEqual(['lastInboundAt', 'lastOutboundAt', 'oldestUnansweredMs', 'state', 'teammate', 'unansweredCount']);
    }
    const serialized = JSON.stringify(status.replyGap);
    expect(serialized).not.toContain(BODY);
    expect(serialized).not.toContain(HANDLE);
    expect(serialized).not.toContain(senderIdFor(HANDLE));
  });
});
