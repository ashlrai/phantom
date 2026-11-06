import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendInboxEntry, parseInbox, readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'inbox-markdown-'));
});

it('keeps an ordinary heading even when it resembles an unstructured historical header', () => {
  const markdown = [
    'preamble',
    '## 2026-01-01 01:02 ET (Mason, terminal) PRIORITY P1', 'first',
    '## legacy heading', 'old', 'body',
    '## 2026-01-02 03:04 ET (Someone, Phantom page) PRIORITY P2', 'second',
    '## 2026-01-03 05:06 ET (Mason, Telegram) PRIORITY P0', 'third', '',
  ].join('\n');

  expect(parseInbox(markdown)).toEqual([
    { at: '2026-01-03 05:06', source: 'Telegram', priority: 'P0', text: 'third' },
    { at: '2026-01-02 03:04', source: 'Phantom page', priority: 'P2', text: 'second' },
    { at: '2026-01-01 01:02', source: 'terminal', priority: 'P1', text: 'first\n## legacy heading\nold\nbody' },
  ]);
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

it('round trips Markdown sections and reads genuine entries newest first', async () => {
  const message = [
    'Shared context 🐙',
    '',
    '## First section',
    'Keep this heading.',
    '',
    '## Code',
    '```sh',
    'printf "hello 🐙\\n"',
    '```',
    '',
    '## Final section',
    'Done.',
  ].join('\r\n');
  const first = await appendInboxEntry(message, {
    runsDir, source: 'terminal', now: () => new Date('2026-10-31T04:13:00Z'),
  });
  const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
  const existing = await readFile(inboxPath, 'utf8');
  const second = await appendInboxEntry('A later message', {
    runsDir, source: 'Telegram', now: () => new Date('2026-10-31T04:14:00Z'),
  });

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect((await readFile(inboxPath, 'utf8')).startsWith(existing)).toBe(true);
  expect(await readInboxEntries({ runsDir })).toEqual({
    sourceState: 'healthy',
    entries: [
      { at: '2026-10-31 00:14', source: 'Telegram', priority: 'P0', text: 'A later message' },
      { at: '2026-10-31 00:13', source: 'terminal', priority: 'P0', text: message.replace(/\r\n/g, '\n') },
    ],
  });
});
