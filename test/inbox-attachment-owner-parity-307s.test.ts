import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INBOX_ATTACH_MAX_CHARS } from '../src/core/fleet/inbox-attachment.js';
import { appendInboxEntry, parseInbox } from '../src/core/fleet/mason-inbox.js';

let runsDir = '';
const now = () => new Date('2026-01-01T12:00:00Z');
afterEach(async () => { if (runsDir) await rm(runsDir, { recursive: true, force: true }); runsDir = ''; });
async function setup(): Promise<void> { runsDir = await mkdtemp(join(tmpdir(), 'inbox-owner-parity-')); }

describe('owner #5221 remaining attachment invariants', () => {
  it('does not accept another entry’s pointer as an attachment', async () => {
    await setup();
    const text = 'A note [full text: leader/inbox-attachments/other-entry.md, 42 chars]';
    const result = await appendInboxEntry(text, { runsDir, now });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('append failed');
    const entries = parseInbox(await readFile(join(runsDir, 'leader/MASON-INBOX.md'), 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(result.id);
    expect(entries[0]?.attachment).toBeUndefined();
  });

  it('rejects raw text over the attachment cap even when normalization shrinks it', async () => {
    await setup();
    const text = `A note\r\n${'ordinary line\r\n'.repeat(4400)}`;
    expect(text.length).toBeGreaterThan(INBOX_ATTACH_MAX_CHARS);
    expect(text.replace(/\r\n/g, '\n').trim().length).toBeLessThanOrEqual(INBOX_ATTACH_MAX_CHARS);
    expect(await appendInboxEntry(text, { runsDir, now })).toEqual({ ok: false, reason: 'too-long' });
    expect(await readdir(runsDir)).toEqual([]);
  });
});
