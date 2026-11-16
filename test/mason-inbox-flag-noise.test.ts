import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { appendInboxEntry, isFlagOnlyInboxText, parseInbox } from '../src/core/fleet/mason-inbox.js';

describe('inbox flag noise', () => {
  it('refuses flag-only and empty messages without touching either file', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'inbox-flags-'));
    try {
      await mkdir(join(runsDir, 'leader'));
      const inbox = join(runsDir, 'leader', 'MASON-INBOX.md');
      const events = join(runsDir, 'dispatch-events.log');
      await writeFile(inbox, 'existing inbox');
      await writeFile(events, 'existing events');
      for (const text of ['--help', '-h', '  --version  ', '--json --help', '', '  \n ']) {
        expect(isFlagOnlyInboxText(text)).toBe(true);
        expect(await appendInboxEntry(text, { runsDir })).toEqual({ ok: false, reason: 'flag-only' });
      }
      expect(await readFile(inbox, 'utf8')).toBe('existing inbox');
      expect(await readFile(events, 'utf8')).toBe('existing events');
    } finally { await rm(runsDir, { recursive: true, force: true }); }
  });

  it('appends ordinary messages, including sentences containing flags, once each', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'inbox-flags-'));
    try {
      for (const text of ['run ashlr fleet x --help and tell me', 'normal text']) {
        expect(isFlagOnlyInboxText(text)).toBe(false);
        expect((await appendInboxEntry(text, { runsDir })).ok).toBe(true);
      }
      const entries = parseInbox(await readFile(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8'));
      expect(entries.map(entry => entry.text)).toEqual(['normal text', 'run ashlr fleet x --help and tell me']);
    } finally { await rm(runsDir, { recursive: true, force: true }); }
  });
});
