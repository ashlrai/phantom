import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INBOX_MAX_CHARS, parseInbox, readInboxEntries } from '../src/core/fleet/mason-inbox.js';

const mixed = `## 2026-11-01 23:38 ET (Mason, fake desktop) PRIORITY P0
Fake older order
2026-11-02T00:27:30-0500 [src:page id:masbot-install] install check from Masbot`;

describe('channel line inbox entries', () => {
  it('splits the channel line from the preceding priority order', () => {
    const entries = parseInbox(mixed);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ at: '2026-11-02 00:27', source: 'page (masbot-install)', priority: null, text: 'install check from Masbot' });
    expect(entries[1]!.text).toBe('Fake older order');
    expect(parseInbox(mixed, 1)).toEqual(entries.slice(0, 1));
  });

  it('converts UTC offsets in EST and EDT and accepts minute precision without an id', () => {
    expect(parseInbox('2026-01-15T05:27:30Z [src:email] Fake winter order')[0]).toEqual({
      at: '2026-01-15 00:27', source: 'email', priority: null, text: 'Fake winter order',
    });
    expect(parseInbox('2026-07-15T04:27+00:00 [src:telegram id:fake-1] Fake summer order')[0]!.at).toBe('2026-07-15 00:27');
  });

  it('keeps non-openers and invalid dates in the preceding body', () => {
    const body = `Fake body contains [src:page id:x] here
2026-11-02T01:00:00-0500 Fake date without tag
2026-13-02T01:00:00-0500 [src:page id:fake] Invalid date
prefix 2026-11-02T01:00:00-0500 [src:page] Fake mid-line tag`;
    const entries = parseInbox(`${mixed}\n${body}`);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe(`install check from Masbot\n${body}`);
  });

  it('caps source and body and switches back to heading entries', () => {
    const source = 'a'.repeat(32);
    const id = 'b'.repeat(64);
    const entries = parseInbox(`2026-11-02T00:27-05:00 [src:${source} id:${id}] Fake\n${'x'.repeat(INBOX_MAX_CHARS)}\n## Fake heading\nFake heading body`);
    expect(entries[1]!.source).toBe(`${source} (${id})`.slice(0, 80));
    expect(entries[1]!.text).toHaveLength(INBOX_MAX_CHARS);
    expect(entries[0]!.text).toBe('Fake heading body');
  });

  it('reads split entries from a temporary runs directory', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'fake-channel-inbox-'));
    try {
      await mkdir(join(runsDir, 'leader'));
      await writeFile(join(runsDir, 'leader', 'MASON-INBOX.md'), mixed);
      expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: parseInbox(mixed) });
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});
