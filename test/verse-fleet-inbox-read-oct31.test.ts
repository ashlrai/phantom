import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { parseInboxReadQuery, projectInboxRead } from '../src/core/verse/fleet-inbox-read.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH as RUNS, VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';

const entry = (at: string, source = 'Telegram') => ({ at, source, priority: 'P0', text: 'an order' });
const raw = { sourceState: 'healthy', entries: [entry('new'), entry('middle', 'desktop'), entry('old', 'telegram')] };
const query = { limit: 50, source: null };

async function request(api: ReturnType<typeof createFleetRunsApi>, url: string, method = 'GET', body?: object, allowDispatch = false) {
  const req = Readable.from(method === 'POST' ? [JSON.stringify(body)] : []) as unknown as IncomingMessage;
  req.url = url; req.method = method; req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'test-token' };
  let status = 0; let wire: unknown;
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text); } } as unknown as ServerResponse;
  const ctx = { token: 'test-token', allowDispatch } as VerseApiContext;
  const handled = await api(ctx, req, res, url.split('?')[0]!, method);
  return { handled, status, wire };
}

describe('inbox read query and projection', () => {
  it('parses defaults and valid parameters from either input', () => {
    expect(parseInboxReadQuery('')).toEqual(query);
    expect(parseInboxReadQuery(new URLSearchParams('limit=3&source=Telegram'))).toEqual({ limit: 3, source: 'Telegram' });
    expect(parseInboxReadQuery('?limit=200')).toEqual({ limit: 200, source: null });
  });
  it('parses the shared read filters into one query', () => {
    expect(parseInboxReadQuery('contains=ship%20it&priority=P1&after=2026-10-31T04%3A12%3A00Z&before=2026-10-31T09%3A47%3A00.500%2B05%3A30'))
      .toEqual({ limit: 50, source: null, contains: 'ship it', priority: 'P1',
        after: { seconds: Date.parse('2026-10-31T04:12:00Z') / 1000, fraction: '' },
        before: { seconds: Date.parse('2026-10-31T04:17:00Z') / 1000, fraction: '5' } });
  });
  it.each(['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=', 'limit=1&limit=2', 'source=', 'source=a%2Fb', 'source=' + 'x'.repeat(41), 'other=x',
    'contains=%20%20', 'contains=' + 'x'.repeat(513), 'priority=P4', 'priority=p1', 'priority=',
    'after=not-a-date', 'after=2026-13-40T99:99:99Z', 'before=2026-10-31', 'after=2026-10-31T04:17:00Z&before=2026-10-31T04:12:00Z',
    'after=2026-10-31T04:12:00Z&after=2026-10-31T04:13:00Z'])('rejects %s', search => {
    expect(parseInboxReadQuery(search)).toHaveProperty('error');
  });
  it('validates, filters, limits, reverses and projects only declared fields', () => {
    const result = projectInboxRead({ ...raw, entries: [
      { ...entry('new'), extra: 'private' }, { source: 'Telegram', priority: null, text: 'no timestamp' },
      { ...entry('bad'), text: '/Users/x' }, { ...entry('bad2'), text: 'x'.repeat(6001) },
      { ...entry('bad3'), priority: 1 }, entry('middle', 'desktop'), { ...entry('old', 'telegram'), priority: null },
    ] }, { limit: 3, source: 'TELEGRAM' });
    expect(result).toMatchObject({ v: 1, sourceState: 'healthy', limit: 3, source: 'TELEGRAM', dropped: 4,
      entries: [{ ...entry('old', 'telegram'), priority: null }, entry('new')] });
    expect(result?.generatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('filters a channel by its bound receipt while rejecting spoofed metadata', () => {
    const result = projectInboxRead({ sourceState: 'healthy', entries: [
      { ...entry('valid', 'phone (phone-1)'), channel: 'phone', id: 'phone-1' },
      { ...entry('spoof', 'desktop (desk-1)'), channel: 'phone', id: 'desk-1' },
      { ...entry('near', 'phone-extra (phone-2)'), channel: 'phone-extra', id: 'phone-2' },
    ] }, { limit: 50, source: 'PHONE' });
    expect(result?.entries).toEqual([entry('valid', 'phone (phone-1)')]);
  });
  it('applies the contains, priority and exclusive window filters before limiting', () => {
    const parsed = parseInboxReadQuery('source=mobile&priority=P0&contains=match&after=2026-10-31T04:12:00Z&before=2026-10-31T04:17:00Z&limit=5');
    if ('error' in parsed) throw new Error('unexpected parse error');
    const timed = (at: string, source: string, priority: string | null, text: string) => ({ at, source, priority, text });
    // Newest-first file order, as the inbox reader supplies it.
    const result = projectInboxRead({ sourceState: 'healthy', entries: [
      timed('2026-10-31 00:16', 'mobile', 'P1', 'other priority match'),
      timed('2026-10-31 00:15', 'desktop', 'P0', 'other source MATCH'),
      timed('2026-10-31 00:14', 'mobile', 'P0', 'second match here'),
      timed('2026-10-31 00:13', 'Mobile', 'P0', 'first MATCH here'),
      timed('2026-10-31 00:11', 'mobile', 'P0', 'too early match'),
      timed('not a date', 'mobile', 'P0', 'undated match'),
    ] }, parsed);
    expect(result).toMatchObject({ dropped: 0, entries: [
      { at: '2026-10-31 00:13', source: 'Mobile', priority: 'P0', text: 'first MATCH here' },
      { at: '2026-10-31 00:14', source: 'mobile', priority: 'P0', text: 'second match here' },
    ] });
  });
  it('keeps undated and out-of-window entries when no time bound is set', () => {
    const result = projectInboxRead({ sourceState: 'healthy', entries: [
      { at: 'not a date', source: 'Telegram', priority: 'P0', text: 'one' },
      entry('middle', 'telegram'),
    ] }, { limit: 50, source: null, contains: 'ONE' });
    expect(result?.entries.map(item => item.text)).toEqual(['one']);
  });
  it('scrubs secrets, rejects paths in all fields and invalid reader envelopes', () => {
    const result = projectInboxRead({ sourceState: 'missing', entries: [
      { ...entry('ok'), text: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
      { ...entry('bad'), at: '/tmp/private' }, { ...entry('bad'), priority: 'C:\\private' },
    ] }, query);
    expect(result?.sourceState).toBe('missing');
    expect(result?.dropped).toBe(2);
    expect(result?.entries[0]?.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(projectInboxRead({ sourceState: 'unknown', entries: [] }, query)).toBeNull();
    expect(projectInboxRead({ sourceState: 'healthy' }, query)).toBeNull();
  });
});

describe('fleet inbox read route', () => {
  it('reads defaults, limits and source filters without dispatch authority', async () => {
    const readInbox = vi.fn(async (_limit: number) => raw);
    const api = createFleetRunsApi({ readInbox });
    expect(await request(api, INBOX)).toMatchObject({ handled: true, status: 200, wire: { limit: 50, source: null, entries: [entry('old', 'telegram'), entry('middle', 'desktop'), entry('new')] } });
    expect((await request(api, INBOX + '?limit=2')).wire).toMatchObject({ entries: [entry('middle', 'desktop'), entry('new')] });
    expect((await request(api, INBOX + '?source=Telegram')).wire).toMatchObject({ entries: [entry('old', 'telegram'), entry('new')] });
    expect(readInbox.mock.calls.map(args => args[0])).toEqual([200, 200, 200]);
  });
  it('reads with the shared filters composed into one window', async () => {
    const timed = (at: string, source: string, priority: string | null, text: string) => ({ at, source, priority, text });
    const readInbox = vi.fn(async (_limit: number) => ({ sourceState: 'healthy', entries: [
      timed('2026-10-31 00:16', 'mobile', 'P1', 'other priority'),
      timed('2026-10-31 00:15', 'desktop', 'P0', 'other source'),
      timed('2026-10-31 00:14', 'mobile', 'P0', 'second match'),
      timed('2026-10-31 00:13', 'Mobile', 'P0', 'first match'),
      timed('2026-10-31 00:11', 'mobile', 'P0', 'too early match'),
    ] }));
    const api = createFleetRunsApi({ readInbox });
    const search = '?source=mobile&priority=P0&contains=match&after=2026-10-31T04:12:00Z&before=2026-10-31T04:17:00Z&limit=5';
    expect(await request(api, INBOX + search)).toMatchObject({ handled: true, status: 200, wire: { entries: [
      { at: '2026-10-31 00:13', text: 'first match' }, { at: '2026-10-31 00:14', text: 'second match' }] } });
    expect(readInbox).toHaveBeenCalledWith(200);
  });
  it.each(['limit=0', 'limit=201', 'limit=abc', 'source=a%2Fb', 'priority=P9', 'after=soon', 'before=2026-10-31T04:12:00Z&after=2026-10-31T04:17:00Z', 'contains=%20'])('rejects %s before reading', async search => {
    const readInbox = vi.fn(async () => raw);
    expect(await request(createFleetRunsApi({ readInbox }), INBOX + '?' + search)).toMatchObject({ status: 400, wire: { code: 'VERSE_INVALID' } });
    expect(readInbox).not.toHaveBeenCalled();
  });
  it('counts bad entries, preserves missing state and handles reader errors', async () => {
    const api = createFleetRunsApi({ readInbox: async () => ({ sourceState: 'missing', entries: [entry('ok'), { text: 'missing' }, { ...entry('bad'), text: '/Users/x' }] }) });
    expect(await request(api, INBOX)).toMatchObject({ status: 200, wire: { sourceState: 'missing', dropped: 2, entries: [entry('ok')] } });
    const failed = createFleetRunsApi({ readInbox: async () => { throw new Error('private'); } });
    expect(await request(failed, INBOX)).toMatchObject({ status: 503, wire: { code: 'INBOX_UNAVAILABLE' } });
  });
  it('preserves the POST gate and the snapshot projection', async () => {
    const appendInbox = vi.fn(async () => ({ ok: true }));
    const api = createFleetRunsApi({ appendInbox, readInbox: async () => [entry('snapshot')], readRunsDir: async () => null,
      listWorkers: async () => null, codexPersonal: async () => null, mergedLastHour: async () => null });
    expect((await request(api, INBOX, 'POST', { text: 'hello' })).status).toBe(404);
    expect(appendInbox).not.toHaveBeenCalled();
    expect(await request(api, INBOX, 'POST', { text: 'hello' }, true)).toMatchObject({ status: 201, wire: { ok: true } });
    expect(appendInbox).toHaveBeenCalledWith('hello', 'Phantom desktop');
    expect(await request(api, RUNS)).toMatchObject({ status: 200, wire: { inbox: [{ at: 'snapshot', source: 'Telegram', text: 'an order' }] } });
    expect(JSON.stringify((await request(api, RUNS)).wire)).not.toContain('priority');
  });
});
