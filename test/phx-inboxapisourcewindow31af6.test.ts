import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatInboxEntry, readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 'fake-test-token';
const WHEN = new Date('2026-10-31T04:13:00Z');
type Api = ReturnType<typeof createFleetRunsApi>;

async function request(api: Api, options: {
  search?: string; method?: 'GET' | 'POST'; body?: unknown; token?: string; allowDispatch?: boolean;
} = {}) {
  const method = options.method ?? 'GET';
  const req = Readable.from(method === 'POST' ? [JSON.stringify(options.body)] : []) as unknown as IncomingMessage;
  req.url = INBOX + (options.search ?? '');
  req.method = method;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? TOKEN };
  let status = 0;
  let wire: unknown;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text); },
  } as unknown as ServerResponse;
  const handled = await api({ token: TOKEN, allowDispatch: options.allowDispatch ?? false } as VerseApiContext, req, res, INBOX, method);
  return { handled, status, wire };
}

describe('fleet inbox bounded source window', () => {
  let runsDir: string;
  beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fake-inbox-window-')); });
  afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

  async function seed(entries: Array<[string, string]>) {
    await mkdir(join(runsDir, 'leader'), { recursive: true });
    await writeFile(join(runsDir, 'leader', 'MASON-INBOX.md'), entries.map(([source, text]) => formatInboxEntry(text, source, WHEN)).join(''));
  }
  function harness() {
    const readInbox = vi.fn((limit: number) => readInboxEntries({ runsDir, limit }));
    return { api: createFleetRunsApi({ readInbox }), readInbox };
  }

  it('finds an older Telegram message behind a newer desktop message', async () => {
    await seed([['Telegram', 'fake older telegram'], ['Phantom desktop', 'fake newer desktop']]);
    const { api, readInbox } = harness();
    expect(await request(api, { search: '?source=Telegram&limit=1' })).toMatchObject({
      handled: true, status: 200, wire: { sourceState: 'healthy', source: 'Telegram', limit: 1, dropped: 0,
        entries: [{ source: 'Telegram', text: 'fake older telegram' }] },
    });
    expect(readInbox).toHaveBeenCalledWith(200);
  });

  it('uses the default result limit after filtering and preserves append order for timestamp ties', async () => {
    await seed([...Array.from({ length: 55 }, (_, i): [string, string] => ['Telegram', `fake telegram ${i}`]),
      ['Phantom desktop', 'fake latest desktop']]);
    const { api, readInbox } = harness();
    const result = await request(api, { search: '?source=telegram' });
    expect(result).toMatchObject({ status: 200, wire: { limit: 50, source: 'telegram', dropped: 0 } });
    const wire = result.wire as { entries: Array<{ text: string; at: string }> };
    expect(wire.entries.map(entry => entry.text)).toEqual(Array.from({ length: 50 }, (_, i) => `fake telegram ${i + 5}`));
    expect(new Set(wire.entries.map(entry => entry.at)).size).toBe(1);
    expect(readInbox).toHaveBeenCalledWith(200);
  });

  it('does not search beyond the 200-entry tail', async () => {
    await seed([['Telegram', 'fake outside window'], ...Array.from({ length: 200 }, (_, i): [string, string] => ['Phantom desktop', `fake desktop ${i}`])]);
    const { api } = harness();
    expect(await request(api, { search: '?source=Telegram&limit=1' })).toMatchObject({ status: 200, wire: { sourceState: 'healthy', entries: [] } });
  });

  it('retains reader state and counts invalid entries throughout the examined window', async () => {
    const entry = { at: 'fake timestamp', source: 'Telegram', priority: 'P0', text: 'fake valid' };
    for (const sourceState of ['missing', 'degraded'] as const) {
      const api = createFleetRunsApi({ readInbox: async () => ({ sourceState, entries: [
        { ...entry, source: 'Phantom desktop', priority: 42 }, entry, { ...entry, text: '/fake/private' },
      ] }) });
      expect(await request(api, { search: '?source=Telegram&limit=1' })).toMatchObject({
        status: 200, wire: { sourceState, dropped: 2, entries: [entry] },
      });
    }
    const failed = createFleetRunsApi({ readInbox: async () => { throw new Error('fake reader failure'); } });
    expect(await request(failed)).toMatchObject({ status: 503, wire: { code: 'INBOX_UNAVAILABLE' } });
    const { api } = harness();
    expect(await request(api)).toMatchObject({ status: 200, wire: { sourceState: 'missing', entries: [] } });
  });

  it.each(['?limit=1&limit=2', '?source=Telegram&source=desktop'])('rejects duplicate query %s before reading', async search => {
    const { api, readInbox } = harness();
    expect(await request(api, { search })).toMatchObject({ status: 400, wire: { code: 'VERSE_INVALID' } });
    expect(readInbox).not.toHaveBeenCalled();
  });

  it('keeps POST dispatch, token and body protections in place', async () => {
    const appendInbox = vi.fn(async () => ({ ok: true, at: 'fake time', bytes: 1 }));
    const api = createFleetRunsApi({ appendInbox, now: () => WHEN.getTime() });
    const body = { text: 'fake message', source: 'Fake desktop' };
    expect((await request(api, { method: 'POST', body })).status).toBe(404);
    expect([401, 403]).toContain((await request(api, { method: 'POST', body, allowDispatch: true, token: 'fake-wrong-token' })).status);
    expect((await request(api, { method: 'POST', body: { ...body, sender: 'fake identity' }, allowDispatch: true })).status).toBe(400);
    expect(appendInbox).not.toHaveBeenCalled();
    expect((await request(api, { method: 'POST', body, allowDispatch: true })).status).toBe(201);
    expect(appendInbox).toHaveBeenCalledOnce();
    expect(appendInbox).toHaveBeenCalledWith('fake message', 'Fake desktop');
  });
});
