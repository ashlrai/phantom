import { describe, expect, it } from 'vitest';
import { commsBriefFacts } from '../src/core/comms/leader-brief-comms.js';
import type { UnifiedInbox, UnifiedInboxItem } from '../src/core/comms/unified-inbox.js';

const NOW = Date.parse('2026-11-09T17:00:00.000Z');
const rep = (state: string, pending = 0) => ({ state, pending });

function inbox(over: Record<string, { state: string; pending: number }> = {}, items: Array<Partial<UnifiedInboxItem>> = []): UnifiedInbox {
  return {
    v: 1,
    generatedAt: new Date(NOW).toISOString(),
    sources: { 'needs-you': rep('healthy'), imessage: rep('healthy'), drafts: rep('healthy'), bus: rep('healthy'), gmail: rep('healthy'), ...over },
    total: 0,
    omitted: 0,
    items: items as UnifiedInboxItem[],
  } as unknown as UnifiedInbox;
}

describe('commsBriefFacts', () => {
  it('is null/null when everything is zero and healthy', () => {
    expect(commsBriefFacts(inbox())).toEqual({ line: null, blocker: null });
  });

  it('flags a Dot text older than 15 minutes as a blocker and in the line', () => {
    const since = new Date(NOW - 40 * 60_000).toISOString();
    const r = commsBriefFacts(inbox({ imessage: rep('healthy', 2) }, [
      { source: 'imessage', since }, { source: 'imessage', since: new Date(NOW - 5 * 60_000).toISOString() },
    ]));
    expect(r.line).toBe('Comms: 2 Dot texts waiting (oldest 40m)');
    expect(r.blocker).toBe('Dot (Ashlr.) waiting 40m on 2 texts');
  });

  it('does not block on a fresh Dot text', () => {
    const r = commsBriefFacts(inbox({ imessage: rep('healthy', 1) }, [{ source: 'imessage', since: new Date(NOW - 3 * 60_000).toISOString() }]));
    expect(r.line).toBe('Comms: 1 Dot text waiting (oldest 3m)');
    expect(r.blocker).toBeNull();
  });

  it('names a degraded or unavailable source as unreadable, not zero', () => {
    const r = commsBriefFacts(inbox({ drafts: rep('unavailable'), imessage: rep('degraded') }));
    expect(r.line).toBe('Comms: imessage unreadable, drafts unreadable');
    expect(r.blocker).toBeNull();
  });

  it('lists Gmail over target with counts, drafts and Needs-you', () => {
    const r = commsBriefFacts(inbox(
      { gmail: rep('healthy', 1), drafts: rep('healthy', 3), 'needs-you': rep('healthy', 2) },
      [{ source: 'gmail', title: 'mason@ashlr.ai: 120 unread, target 50' }],
    ));
    expect(r.line).toBe('Comms: 2 Needs-you, 3 drafts to approve, mason@ashlr.ai 120/50 unread');
  });

  it('tolerates an unknown extra source key', () => {
    const r = commsBriefFacts(inbox({ linkedin: rep('healthy', 4) }));
    expect(r.line).toBeNull();
    expect(commsBriefFacts(inbox({ linkedin: rep('degraded') })).line).toBe('Comms: linkedin unreadable');
  });
});
