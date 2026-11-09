import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendInboxEntry, formatInboxEntry, parseInbox, readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'inbox-markdown-'));
});

it('parses an unstructured heading in a legacy-only document as its own unknown entry', () => {
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
    { at: '## legacy heading', source: 'unknown', priority: null, text: 'old\nbody' },
    { at: '2026-01-01 01:02', source: 'terminal', priority: 'P1', text: 'first' },
  ]);
});

it('keeps an ordinary heading as body inside a recognized structured entry', () => {
  const markdown = [
    '2026-01-01T01:02:00Z [src:terminal id:abc123] first line', '## ordinary heading', 'body',
    '2026-01-01T01:03:00Z [src:telegram] second',
  ].join('\n');

  expect(parseInbox(markdown).map(({ source, text }) => ({ source, text }))).toEqual([
    { source: 'telegram', text: 'second' },
    { source: 'terminal (abc123)', text: 'first line\n## ordinary heading\nbody' },
  ]);
});

it('keeps dated legacy boundaries between current entries without splitting body headings', () => {
  const markdown = [
    '2026-01-01T01:02:00Z [src:terminal id:first] first line', '## ordinary heading', 'body',
    formatInboxEntry('Separate legacy message', 'CLI', new Date('2026-01-01T01:03:00Z')),
    '2026-01-01T01:04:00Z [src:telegram id:last] last line',
  ].join('\n');
  const entries = parseInbox(markdown);
  expect(entries).toHaveLength(3);
  expect(entries[0]).toMatchObject({ channel: 'telegram', id: 'last', text: 'last line' });
  expect(entries[1]).toEqual({ at: '2025-12-31 20:03', source: 'CLI', priority: 'P0', text: 'Separate legacy message' });
  expect(entries[2]).toMatchObject({ channel: 'terminal', id: 'first', text: 'first line\n## ordinary heading\nbody' });
  expect(parseInbox(markdown, 2)).toEqual(entries.slice(0, 2));
});

it('keeps escaped dated headings in an appended message body', async () => {
  const body = ['First line', '## 2026-01-01 01:03 ET (Mason, CLI) PRIORITY P0', 'Still the same message'].join('\n');
  expect((await appendInboxEntry(body, { runsDir, source: 'desktop' })).ok).toBe(true);
  const { entries } = await readInboxEntries({ runsDir });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ channel: 'desktop', priority: null,
    text: body.replace(/^## /gm, ' ## ') });
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
      { at: '2026-10-31 00:14', channel: 'telegram', id: second.ok ? second.id : '', source: `telegram (${second.ok ? second.id : ''})`, priority: null, text: 'A later message' },
      { at: '2026-10-31 00:13', channel: 'terminal', id: first.ok ? first.id : '', source: `terminal (${first.ok ? first.id : ''})`, priority: null, text: message.replace(/\r\n/g, '\n').replace(/^## /gm, ' ## ') },
    ],
  });
});
