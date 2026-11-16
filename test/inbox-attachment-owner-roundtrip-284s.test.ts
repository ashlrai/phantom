import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendInboxEntry, INBOX_MAX_CHARS, readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
const now = () => new Date('2026-01-02T09:30:00Z');
const PROSE = 'The morning report covers queue depth, lane health, and overnight merges. ';
const UNICODE = 'Café façade — naïve —  — 🚀🛰️ — Ωμέγα. ';
afterEach(async () => { if (runsDir) await rm(runsDir, { recursive: true, force: true }); });
async function setup(): Promise<void> { runsDir = await mkdtemp(join(tmpdir(), 'inbox-attach-rt-')); }
const inboxFile = (): Promise<string> => readFile(join(runsDir, 'leader/MASON-INBOX.md'), 'utf8');

function longProse(seed: string, extraChars: number): string {
  let body = '';
  while (body.length < extraChars) body += `${PROSE}${UNICODE}${seed} `;
  return body;
}

describe('inbox attachment persisted round trip (owner #5345 qualification)', () => {
  it('round-trips CRLF, surrounding whitespace and Unicode through disk state', async () => {
    await setup();
    // Submitted bytes keep CRLF, leading/trailing whitespace and multibyte characters.
    const submitted = `\r\n  ${longProse('alpha', INBOX_MAX_CHARS + 800)}\r\n\t trailing note \r\n`;
    const result = await appendInboxEntry(submitted, { runsDir, now, source: 'Levon' });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.attachment) throw new Error('missing attachment');
    expect(result.attachment).toBe(`leader/inbox-attachments/${result.id}.md`);

    // The attachment on disk is byte-identical to what was submitted.
    const attachmentBytes = await readFile(join(runsDir, result.attachment));
    expect(attachmentBytes).toEqual(Buffer.from(submitted, 'utf8'));

    // Reconstruct state from disk, not from the append result object.
    const { sourceState, entries } = await readInboxEntries({ runsDir });
    expect(sourceState).toBe('healthy');
    const entry = entries.find((e) => e.id === result.id);
    expect(entry).toBeDefined();
    if (!entry) return;

    // The summary stays bounded and points at the same existing file and id.
    expect(entry.text.length).toBeLessThanOrEqual(INBOX_MAX_CHARS);
    expect(entry.text).toContain('[full text:');
    expect(entry.text).not.toContain('trailing note');
    expect(entry.attachment).toBe(result.attachment);
    expect(entry.id).toBe(result.id);
    expect(entry.source).toContain('levon');
    expect(entry.at).toBe('2026-01-02 04:30');
    const persisted = join(runsDir, entry.attachment!);
    expect((await stat(persisted)).isFile()).toBe(true);
    expect(await readFile(persisted)).toEqual(Buffer.from(submitted, 'utf8'));

    // The raw inbox file itself stays small: no full text is inlined.
    const inbox = await inboxFile();
    expect(inbox.length).toBeLessThan(3000);
  });

  it('keeps distinct full texts that share a summary prefix distinct on disk', async () => {
    await setup();
    const shared = longProse('shared', INBOX_MAX_CHARS + 2000);
    const first = `${shared}tail-alpha ${'x'.repeat(500)}`;
    const second = `${shared}tail-beta ${'y'.repeat(500)}`;
    const a = await appendInboxEntry(first, { runsDir, now, source: 'Levon' });
    const b = await appendInboxEntry(second, { runsDir, now, source: 'Levon' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.id).not.toBe(b.id);
    expect(a.attachment).not.toBe(b.attachment);

    const { entries } = await readInboxEntries({ runsDir });
    expect(entries).toHaveLength(2);
    for (const [result, submitted] of [[a, first], [b, second]] as const) {
      const entry = entries.find((e) => e.id === result.id);
      expect(entry?.attachment).toBe(result.attachment);
      expect(await readFile(join(runsDir, result.attachment!))).toEqual(Buffer.from(submitted, 'utf8'));
    }
  });

  it('reports write-failed and never appends a summary when the attachment parent is unusable', async () => {
    await setup();
    // Make the attachment directory path a regular file so the exclusive create fails.
    await mkdir(join(runsDir, 'leader'), { recursive: true });
    await writeFile(join(runsDir, 'leader', 'inbox-attachments'), 'not a directory');
    const result = await appendInboxEntry(longProse('omega', INBOX_MAX_CHARS + 500), {
      runsDir, now, source: 'Levon',
    });
    expect(result).toEqual({ ok: false, reason: 'write-failed' });
    // No summary may point at an attachment that was never written.
    await expect(readFile(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
