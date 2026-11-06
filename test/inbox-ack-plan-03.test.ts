import { describe, expect, it } from 'vitest';
import { inboxAckEntry, planInboxAcks } from '../src/core/fleet/inbox-ack.js';

const briefAt = '2026-11-02 00:30 ET';

describe('inbox acknowledgement planning', () => {
  it('extracts the channel, id, and message from a routed entry', () => {
    expect(inboxAckEntry('2026-11-02T00:27:30-0500 [src:telegram id:fake-1] please pause lane x', briefAt))
      .toEqual({ channel: 'telegram', entryId: 'fake-1', text: 'please pause lane x', briefAt });
  });

  it('derives a stable hexadecimal id when one is absent', () => {
    const raw = '2026-11-02T00:27:30-0500 [src:desktop] please pause lane x';
    const first = inboxAckEntry(raw, briefAt);
    expect(first.entryId).toMatch(/^[a-f0-9]{64}$/);
    expect(inboxAckEntry(raw, briefAt).entryId).toBe(first.entryId);
  });

  it('does not acknowledge legacy headings without a channel', () => {
    const entry = inboxAckEntry('## 2026-11-01 18:06 ET (Mason, relayed) PRIORITY P0', briefAt);
    expect(entry.channel).toBeNull();
    expect(planInboxAcks([entry], new Set())).toEqual([]);
  });

  it('deduplicates against the ledger and repeated input without mutating the ledger', () => {
    const recorded = inboxAckEntry('2026-11-02T00:27:30-0500 [src:desktop id:fake-1] pause lane x', briefAt);
    const fresh = inboxAckEntry('2026-11-02T00:27:30-0500 [src:email id:fake-2] resume lane y', briefAt);
    const ledger = new Set([recorded.entryId]);
    expect(planInboxAcks([recorded, fresh, fresh], ledger)).toEqual([
      { entryId: 'fake-2', channel: 'email', text: `Got it: resume lane y. In the planner brief at ${briefAt}.` },
    ]);
    expect([...ledger]).toEqual([recorded.entryId]);
  });

  it('normalizes whitespace and limits the preview to 80 characters', () => {
    const text = `  please\n  pause\t${'x'.repeat(90)}  `;
    const entry = inboxAckEntry(`2026-11-02T00:27:30-0500 [src:telegram id:fake-3] ${text}`, briefAt);
    const [ack] = planInboxAcks([entry], new Set());
    const preview = `please pause ${'x'.repeat(90)}`.slice(0, 80);
    expect(preview).toHaveLength(80);
    expect(ack.text).toBe(`Got it: ${preview}. In the planner brief at ${briefAt}.`);
  });
});
