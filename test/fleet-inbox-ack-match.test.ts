import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetInboxAcks } from '../src/cli/fleet-inbox-acks.js';
import { inboxEntryTimestamp, isAnsweredByReplies, noChannelReason } from '../src/core/fleet/inbox-ack-match.js';

const RAW = '2026-11-02T00:27:30-0500 [src:page id:fake-a] where is the fake report';
const entry = { entryId: 'fake-a', raw: RAW };

describe('isAnsweredByReplies', () => {
  it('acks an entry whose id is named in a later reply', () => {
    expect(isAnsweredByReplies(entry, [{ at: '2026-11-02 01:00', text: 'Answer for fake-a: it is done.' }])).toBe(true);
  });
  it('acks an entry whose timestamp is named in a later reply', () => {
    expect(isAnsweredByReplies({ entryId: 'x', raw: RAW }, [{ at: '2026-11-02T06:00:00Z', text: 'Re your 2026-11-02T00:27:30-0500 note: done.' }])).toBe(true);
  });
  it('leaves an entry pending when no reply names it', () => {
    expect(isAnsweredByReplies(entry, [{ at: '2026-11-02 01:00', text: 'Something about another thing.' }])).toBe(false);
  });
  it('ignores a reply written before the entry', () => {
    expect(isAnsweredByReplies(entry, [{ at: '2026-11-01 01:00', text: 'fake-a' }])).toBe(false);
  });
  it('reads legacy heading timestamps', () => {
    expect(inboxEntryTimestamp('## 2026-11-01 18:06 ET (Mason, relayed) PRIORITY P0\nplain')).toBe('2026-11-01 18:06');
  });
  it('words the no-channel reason plainly', () => {
    expect(noChannelReason('page')).toBe('came from page; no reply channel wired, answered in PLAN-LOG');
  });
});

describe('inbox-acks command with leader replies', () => {
  let runs: string;
  let out: string[];
  beforeEach(() => {
    runs = mkdtempSync(join(tmpdir(), 'inbox-match-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    mkdirSync(join(runs, 'leader'), { recursive: true });
    writeFileSync(join(runs, 'leader', 'MASON-INBOX.md'), [
      RAW,
      '2026-11-02T00:28:30-0500 [src:phone id:fake-b] another plain question',
      '## 2026-11-01 18:06 ET (page relay) PRIORITY P0\nplain legacy order',
    ].join('\n') + '\n');
    writeFileSync(join(runs, 'leader', 'PLAN-LOG.md'), '## 2026-11-02 02:00 ET\n\nReply for Mason: fake-a is answered, the report is done.\n');
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(runs, { recursive: true, force: true }); });

  it('shows acked, pending and no-channel with a reason', async () => {
    expect(await cmdFleetInboxAcks(['--runs-dir', runs, '--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    const byId = Object.fromEntries(json.entries.map((e: { entryId: string }) => [e.entryId, e]));
    expect(byId['fake-a'].state).toBe('acked');
    expect(byId['fake-b'].state).toBe('pending');
    const legacy = json.entries.find((e: { channel: unknown }) => e.channel === null);
    expect(legacy.state).toBe('no-channel');
    expect(legacy.reason).toBe('came from page relay; no reply channel wired, answered in PLAN-LOG');
  });
});
