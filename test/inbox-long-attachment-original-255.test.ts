import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendInboxEntry, INBOX_MAX_CHARS, parseInbox } from '../src/core/fleet/mason-inbox.js';
import { inboxAttachmentPath, INBOX_ATTACH_MAX_CHARS } from '../src/core/fleet/inbox-attachment.js';

let runsDir: string;
const now = () => new Date('2026-01-01T12:00:00Z');
const LONG = 'long message '.repeat(1000);
afterEach(async () => { if (runsDir) await rm(runsDir, { recursive: true, force: true }); });
async function setup(): Promise<void> { runsDir = await mkdtemp(join(tmpdir(), 'inbox-long-attach-')); }
const inboxFile = (): Promise<string> => readFile(join(runsDir, 'leader/MASON-INBOX.md'), 'utf8');

describe('long inbox attachments (original #4815 recovery)', () => {
  it('keeps short entries unchanged without an attachment', async () => {
    await setup();
    const text = 'word '.repeat(1199) + 'word';
    const result = await appendInboxEntry(text, { runsDir, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toBeUndefined();
    const inbox = await inboxFile();
    expect(parseInbox(inbox)[0]?.text).toBe(text);
    await expect(readdir(join(runsDir, 'leader/inbox-attachments'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores the complete long text and parses its pointer', async () => {
    await setup();
    const result = await appendInboxEntry(LONG, { runsDir, now, source: 'Levon' });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.attachment) throw new Error('missing attachment');
    expect(result.attachment).toBe(`leader/inbox-attachments/${result.id}.md`);
    // The full submitted text is preserved byte-for-byte on disk.
    expect(await readFile(join(runsDir, result.attachment), 'utf8')).toBe(LONG);
    const inbox = await inboxFile();
    expect(inbox.length).toBeLessThan(1700);
    const entry = parseInbox(inbox)[0];
    expect(entry?.attachment).toBe(result.attachment);
    expect(entry?.text).toContain('[full text:');
    expect(entry?.text).not.toBe(LONG);
    // Source and date attribution survive the round trip.
    expect(entry?.source).toContain('levon');
    expect(entry?.at).toBe('2026-01-01 07:00');
  });

  it('derives the entry id from the full text, not the summary', async () => {
    await setup();
    const first = await appendInboxEntry(LONG, { runsDir, now });
    const second = await appendInboxEntry(`${LONG}tail`, { runsDir, now });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.id).not.toBe(first.id);
    expect(second.attachment).not.toBe(first.attachment);
  });

  it('accepts the boundary sizes: inline at INBOX_MAX_CHARS, attachment above it, too-long past the attach cap', async () => {
    await setup();
    const inline = await appendInboxEntry('x'.repeat(INBOX_MAX_CHARS), { runsDir, now });
    expect(inline.ok).toBe(true);
    if (inline.ok) expect(inline.attachment).toBeUndefined();
    const attached = await appendInboxEntry('y'.repeat(INBOX_MAX_CHARS + 1), { runsDir, now: () => new Date('2026-01-01T12:00:01Z') });
    expect(attached.ok).toBe(true);
    if (attached.ok) expect(attached.attachment).toBeDefined();
    expect(await appendInboxEntry('x'.repeat(INBOX_ATTACH_MAX_CHARS + 1), { runsDir, now: () => new Date('2026-01-01T12:00:02Z') })).toEqual({ ok: false, reason: 'too-long' });
  });

  it('rejects oversized and secret-shaped text without writing', async () => {
    await setup();
    expect(await appendInboxEntry('x'.repeat(INBOX_ATTACH_MAX_CHARS + 1), { runsDir, now })).toEqual({ ok: false, reason: 'too-long' });
    expect(await appendInboxEntry(`${'x '.repeat(4000)} sk-FAKEFAKEFAKEFAKEFAKEFAKE1234`, { runsDir, now })).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(await appendInboxEntry(`short sk-FAKEFAKEFAKEFAKEFAKE1234`, { runsDir, now })).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(await readdir(runsDir)).toEqual([]);
  });

  it('does not write during dry runs or overwrite an existing attachment', async () => {
    await setup();
    const result = await appendInboxEntry(LONG, { runsDir, now, dryRun: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachment).toBeDefined();
    expect(await readdir(runsDir)).toEqual([]);
    const first = await appendInboxEntry(LONG, { runsDir, now });
    expect(first.ok).toBe(true);
    // Same text + same timestamp => same id => exclusive create refuses the second write.
    expect(await appendInboxEntry(LONG, { runsDir, now })).toEqual({ ok: false, reason: 'write-failed' });
    if (first.ok && first.attachment) {
      expect(await readFile(join(runsDir, first.attachment), 'utf8')).toBe(LONG);
      expect(parseInbox(await inboxFile())).toHaveLength(1);
    }
  });

  it('rejects traversal and malformed attachment ids', () => {
    expect(() => inboxAttachmentPath('/tmp/runs', '../escape')).toThrow('Invalid inbox attachment id');
    expect(() => inboxAttachmentPath('/tmp/runs', 'a/b')).toThrow('Invalid inbox attachment id');
    expect(() => inboxAttachmentPath('/tmp/runs', '.')).toThrow('Invalid inbox attachment id');
    expect(() => inboxAttachmentPath('/tmp/runs', '..')).toThrow('Invalid inbox attachment id');
    expect(inboxAttachmentPath('/tmp/runs', 'desk-ab12cd34ef56gh78')).toBe(join('/tmp/runs', 'leader', 'inbox-attachments', 'desk-ab12cd34ef56gh78.md'));
  });
});
