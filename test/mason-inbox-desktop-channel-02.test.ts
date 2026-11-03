import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acknowledgeInboxEntries, inboxAckEntry, type InboxAck } from '../src/core/fleet/inbox-ack.js';
import { appendInboxEntry, parseInbox } from '../src/core/fleet/mason-inbox.js';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

describe('desktop inbox post is acknowledged on the desktop channel', () => {
  it('writes a channel line that parses, extracts and acks once', async () => {
    dir = await mkdtemp(join(tmpdir(), 'inbox-desktop-'));
    const now = new Date('2026-11-02T05:30:00.000Z');
    const text = 'Ship the fix\nsecond line\nthird line';
    const result = await appendInboxEntry(text, { runsDir: dir, now: () => now, source: 'Phantom desktop chat' });
    expect(result.ok).toBe(true);

    const markdown = await readFile(join(dir, 'leader', 'MASON-INBOX.md'), 'utf8');
    const [entry] = parseInbox(markdown);
    expect(entry).toMatchObject({ at: '2026-11-02 00:30', text, priority: null });
    expect(entry!.source).toMatch(/^desktop \(desk-[0-9a-f]{16}\)$/);

    const raw = markdown.split('\n').slice(1, 4).join('\n');
    const ack = inboxAckEntry(raw, now.toISOString());
    expect(ack.channel).toBe('desktop');
    expect(entry!.source).toBe(`desktop (${ack.entryId})`);
    expect(ack.text).toContain('third line');

    const sent: InboxAck[] = [];
    const senders = { desktop: async (a: InboxAck) => { sent.push(a); } };
    await acknowledgeInboxEntries([raw], dir, now.toISOString(), senders);
    await acknowledgeInboxEntries([raw], dir, now.toISOString(), senders);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ entryId: ack.entryId, channel: 'desktop' });
  });

  it('uses the phone channel for mobile posts and keeps the dispatch event', async () => {
    dir = await mkdtemp(join(tmpdir(), 'inbox-phone-'));
    await appendInboxEntry('from phone', { runsDir: dir, now: () => new Date('2026-11-02T05:30:00.000Z'), source: 'Phantom mobile' });
    const markdown = await readFile(join(dir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(markdown).toMatch(/\[src:phone id:phone-[0-9a-f]{16}\] from phone/);
    expect(await readFile(join(dir, 'dispatch-events.log'), 'utf8')).toContain('INBOX new entry from Phantom mobile');
  });
});
