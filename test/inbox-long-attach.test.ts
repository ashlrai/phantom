import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendInboxEntry, parseInbox } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
const now = () => new Date('2026-01-01T12:00:00Z');
afterEach(async () => { if (runsDir) await rm(runsDir, { recursive: true, force: true }); });
async function setup(): Promise<void> { runsDir = await mkdtemp(join(tmpdir(), 'inbox-long-')); }

describe('long inbox attachments', () => {
  it('keeps short entries unchanged without an attachment', async () => {
    await setup();
    const text = 'word '.repeat(1199) + 'word';
    const result = await appendInboxEntry(text, { runsDir, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toBeUndefined();
    const inbox = await readFile(join(runsDir, 'leader/MASON-INBOX.md'), 'utf8');
    expect(parseInbox(inbox)[0]?.text).toBe(text);
    await expect(readdir(join(runsDir, 'leader/inbox-attachments'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('stores the complete long text and parses its pointer', async () => {
    await setup();
    const text = 'long message '.repeat(1000);
    const result = await appendInboxEntry(text, { runsDir, now });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.attachment) throw new Error('missing attachment');
    expect(await readFile(join(runsDir, result.attachment), 'utf8')).toBe(text);
    const inbox = await readFile(join(runsDir, 'leader/MASON-INBOX.md'), 'utf8');
    expect(inbox.length).toBeLessThan(1700);
    expect(parseInbox(inbox)[0]?.attachment).toBe(result.attachment);
  });
  it('rejects oversized and secret-shaped text without writing', async () => {
    await setup();
    expect(await appendInboxEntry('x'.repeat(70000), { runsDir, now })).toEqual({ ok: false, reason: 'too-long' });
    expect(await appendInboxEntry(`${'x '.repeat(4000)} sk-FAKEFAKEFAKEFAKEFAKEFAKE1234`, { runsDir, now })).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(await readdir(runsDir)).toEqual([]);
  });
  it('does not write during dry runs or overwrite an existing attachment', async () => {
    await setup();
    const text = 'message '.repeat(1500);
    expect((await appendInboxEntry(text, { runsDir, now, dryRun: true })).ok).toBe(true);
    expect(await readdir(runsDir)).toEqual([]);
    const first = await appendInboxEntry(text, { runsDir, now });
    expect(first.ok).toBe(true);
    expect(await appendInboxEntry(text, { runsDir, now })).toEqual({ ok: false, reason: 'write-failed' });
    if (first.ok && first.attachment) expect(await readFile(join(runsDir, first.attachment), 'utf8')).toBe(text);
  });
});
