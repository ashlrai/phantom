import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { projectInboxRead } from '../src/core/verse/fleet-inbox-read.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { narrowInboxRead } from '../src/web-ui/routes/verse/mobile/inbox-read-query.js';

// All three final entries share a minute; append order breaks timestamp ties.
const markdown = [
  '## 2026-10-31 00:11 ET (Fake operator, Telegram) PRIORITY P1', 'older telegram',
  '## 2026-10-31 00:12 ET (Fake operator, Phantom desktop) PRIORITY P0', 'older desktop',
  '## 2026-10-31 00:13 ET (Fake operator, Telegram) PRIORITY P0', 'middle telegram',
  '## 2026-10-31 00:13 ET (Fake operator, Phantom desktop) PRIORITY P1', 'newer desktop',
  '## 2026-10-31 00:13 ET (Fake operator, telegram) PRIORITY P0', 'newest telegram',
].join('\n');

describe('source-filtered inbox chronology', () => {
  it('selects the newest matching parsed entries and emits them oldest first', () => {
    const parsed = parseInbox(markdown, 20);
    expect(parsed.map(entry => entry.text)).toEqual([
      'newest telegram', 'newer desktop', 'middle telegram', 'older desktop', 'older telegram',
    ]);
    const wire = projectInboxRead({ sourceState: 'healthy', entries: parsed }, { limit: 2, source: 'TELEGRAM' });
    expect(wire).toMatchObject({ source: 'TELEGRAM', limit: 2, dropped: 0, entries: [
      { at: '2026-10-31 00:13', source: 'Telegram', priority: 'P0', text: 'middle telegram' },
      { at: '2026-10-31 00:13', source: 'telegram', priority: 'P0', text: 'newest telegram' },
    ] });
    expect(narrowInboxRead(wire)?.entries.map(entry => entry.text)).toEqual(['newest telegram', 'middle telegram']);
  });

  it('preserves file order for ties without a source filter and does not count filtering or limits as drops', () => {
    const parsed = parseInbox(markdown, 20);
    const wire = projectInboxRead({ sourceState: 'healthy', entries: parsed }, { limit: 3, source: null });
    expect(wire).toMatchObject({ dropped: 0, entries: [
      { source: 'Telegram', text: 'middle telegram' },
      { source: 'Phantom desktop', text: 'newer desktop' },
      { source: 'telegram', text: 'newest telegram' },
    ] });
  });

  it('screens unsafe rows and counts only rejected rows, including outside the selected source', () => {
    const parsed = parseInbox(markdown, 20);
    const wire = projectInboxRead({ sourceState: 'healthy', entries: [
      { at: '2026-10-31 00:14', source: 'Telegram', priority: 'P0', text: '/fake/private/file' },
      { at: '2026-10-31 00:14', source: 'Phantom desktop', priority: 3, text: 'invalid priority' },
      ...parsed,
    ] }, { limit: 1, source: 'telegram' });
    expect(wire).toMatchObject({ dropped: 2, entries: [
      { source: 'telegram', text: 'newest telegram' },
    ] });
    expect(JSON.stringify(wire)).not.toContain('/fake/private/file');
  });

  it('returns the newest matching entries through the route when other sources are interleaved', async () => {
    const api = createFleetRunsApi({ readInbox: async limit => ({ sourceState: 'healthy', entries: parseInbox(markdown, limit) }) });
    const url = `${VERSE_FLEET_RUNS_INBOX_PATH}?limit=2&source=Telegram`;
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = url;
    req.method = 'GET';
    req.headers = {};
    let status = 0;
    let wire: unknown;
    const res = { writeHead(code: number) { status = code; }, end(body: string) { wire = JSON.parse(body); } } as unknown as ServerResponse;
    await api({ allowDispatch: false } as VerseApiContext, req, res, VERSE_FLEET_RUNS_INBOX_PATH, 'GET');
    expect(status).toBe(200);
    expect(wire).toMatchObject({ dropped: 0, entries: [
      { source: 'Telegram', text: 'middle telegram' },
      { source: 'telegram', text: 'newest telegram' },
    ] });
  });
});
