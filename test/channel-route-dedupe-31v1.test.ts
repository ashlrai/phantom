import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH as RUNS, VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';

const TOKEN = 'channel-route-31v1-token';
const NOW = Date.parse('2026-10-31T12:00:00Z');

type Append = (text: string, source: string) => Promise<unknown>;
const okAppend = (): Append => async () => ({ ok: true, at: 'fake-at', bytes: 1 });

function deps(over: Partial<FleetRunsApiDeps> = {}): FleetRunsApiDeps {
  return {
    now: () => NOW,
    readRunsDir: async () => ({}),
    listWorkers: async () => ({}),
    readInbox: async () => [],
    appendInbox: okAppend(),
    codexPersonal: async () => null,
    mergedLastHour: async () => ({ count: 0, items: [] }),
    ...over,
  };
}

interface Reply { handled: boolean; status: number; wire: Record<string, unknown> | null }

async function request(api: ReturnType<typeof createFleetRunsApi>, options: {
  path: string; method?: string; body?: unknown; token?: string | null; allowDispatch?: boolean; contentType?: string;
}): Promise<Reply> {
  const method = options.method ?? 'GET';
  const req = Readable.from(method === 'GET' ? [] : [JSON.stringify(options.body ?? {})]) as unknown as IncomingMessage;
  req.url = options.path;
  req.method = method;
  req.headers = { 'content-type': options.contentType ?? 'application/json' };
  if (options.token !== null) req.headers['x-ashlr-token'] = options.token ?? TOKEN;
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: options.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, options.path.split('?')[0]!, method);
  return { handled, status, wire };
}

const post = (api: ReturnType<typeof createFleetRunsApi>, body: unknown, over: Partial<Parameters<typeof request>[1]> = {}) =>
  request(api, { path: INBOX, method: 'POST', body, ...over });
const get = (api: ReturnType<typeof createFleetRunsApi>) => request(api, { path: RUNS });

describe('channel route dedupe (RQ-PHX-CHANNELROUTE31V1)', () => {
  it('appends once for two concurrent equivalent submissions and acknowledges both', async () => {
    const append = vi.fn(okAppend());
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    const [a, b] = await Promise.all([
      post(api, { text: 'hello world' }),
      post(api, { text: '  hello world  ' }),
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith('hello world', 'Phantom desktop');
    const accepted = [a, b].find((r) => r.wire?.accepted === true);
    const duplicate = [a, b].find((r) => r.wire?.duplicate === true);
    expect(accepted?.status).toBe(201);
    expect(duplicate?.status).toBe(200);
    for (const reply of [a, b]) {
      expect(reply.wire?.ok).toBe(true);
      expect(reply.wire?.at).toBe(new Date(NOW).toISOString());
      expect(reply.wire?.dedupeKey).toMatch(/^sha256:[a-f0-9]{24}$/);
      expect(JSON.stringify(reply.wire)).not.toContain(TOKEN);
    }
    expect(duplicate?.wire?.dedupeKey).toBe(accepted?.wire?.dedupeKey);
  });

  it('dedupes NFC-equivalent and CRLF-equivalent bodies', async () => {
    const append = vi.fn(okAppend());
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    const composed = await post(api, { text: 'caf\u00e9' });
    const decomposed = await post(api, { text: 'cafe\u0301' });
    const crlf = await post(api, { text: 'line one\r\nline two' });
    const lf = await post(api, { text: 'line one\nline two' });
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(1, 'caf\u00e9', 'Phantom desktop');
    expect(append).toHaveBeenNthCalledWith(2, 'line one\nline two', 'Phantom desktop');
    expect(composed.wire?.accepted).toBe(true);
    expect(crlf.wire?.accepted).toBe(true);
    expect(decomposed.wire?.duplicate).toBe(true);
    expect(lf.wire?.duplicate).toBe(true);
    expect(decomposed.wire?.dedupeKey).toBe(composed.wire?.dedupeKey);
    expect(lf.wire?.dedupeKey).toBe(crlf.wire?.dedupeKey);
  });

  it('persists distinct bodies separately with distinct dedupe keys', async () => {
    const append = vi.fn(okAppend());
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    const first = await post(api, { text: 'alpha' });
    const second = await post(api, { text: 'beta' });
    expect(append).toHaveBeenCalledTimes(2);
    expect(first.wire?.accepted).toBe(true);
    expect(second.wire?.accepted).toBe(true);
    expect(first.wire?.dedupeKey).not.toBe(second.wire?.dedupeKey);
  });

  it('lets a failed append retry instead of reserving the key', async () => {
    const append = vi.fn(okAppend());
    append.mockRejectedValueOnce(new Error('fake disk failure'));
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    const failed = await post(api, { text: 'retry me' });
    expect(failed.status).toBe(503);
    expect(failed.wire?.code).toBe('INBOX_UNAVAILABLE');
    const retry = await post(api, { text: 'retry me' });
    expect(retry.status).toBe(201);
    expect(retry.wire?.accepted).toBe(true);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('keeps refusal-shaped sink replies honest', async () => {
    const api = createFleetRunsApi(deps({ appendInbox: async () => ({ ok: false, reason: 'secret-shaped' }) }));
    const refused = await post(api, { text: 'anything' });
    expect(refused.status).toBe(422);
    expect(refused.wire?.code).toBe('INBOX_REFUSED');
    expect(refused.wire?.reason).toBe('secret-shaped');
    const api2 = createFleetRunsApi(deps({ appendInbox: async () => ({ nonsense: true }) }));
    const weird = await post(api2, { text: 'anything' });
    expect(weird.status).toBe(503);
    expect(weird.wire?.code).toBe('INBOX_UNAVAILABLE');
  });

  it('never reaches the receiver or sink when disabled or unauthenticated, and leaves no dedupe state', async () => {
    const append = vi.fn(okAppend());
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    expect((await post(api, { text: 'blocked' }, { allowDispatch: false })).status).toBe(404);
    expect((await post(api, { text: 'blocked' }, { token: 'wrong-token' })).status).toBe(401);
    expect((await post(api, { text: 'blocked' }, { token: null })).status).toBe(401);
    expect((await post(api, { text: 'blocked' }, { contentType: 'text/plain' })).status).toBe(415);
    expect(append).not.toHaveBeenCalled();
    // None of the rejected attempts reserved the dedupe key.
    const legit = await post(api, { text: 'blocked' });
    expect(legit.status).toBe(201);
    expect(legit.wire?.accepted).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('treats source as presentation metadata: it neither bypasses dedupe nor authenticates', async () => {
    const append = vi.fn(okAppend());
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    const first = await post(api, { text: 'same body', source: 'ios' });
    const second = await post(api, { text: 'same body', source: 'web' });
    expect(first.wire?.accepted).toBe(true);
    expect(second.wire?.duplicate).toBe(true);
    expect(second.wire?.dedupeKey).toBe(first.wire?.dedupeKey);
    expect(append).toHaveBeenCalledTimes(1);
    // The stored label is the first (persisting) request's source.
    expect(append).toHaveBeenCalledWith('same body', 'ios');
    // A new body carries its own source through to the sink.
    const third = await post(api, { text: 'other body', source: 'web' });
    expect(third.wire?.accepted).toBe(true);
    expect(append).toHaveBeenLastCalledWith('other body', 'web');
    // No claimed source can substitute for the mutation token.
    for (const source of ['ios', 'web', 'Phantom desktop']) {
      expect((await post(api, { text: 'x', source }, { token: 'wrong' })).status).toBe(401);
    }
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('attributes a concurrent first write to its own request source', async () => {
    const append = vi.fn(okAppend());
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    const [a, b] = await Promise.all([
      post(api, { text: 'shared body', source: 'ios' }),
      post(api, { text: 'shared body', source: 'web' }),
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    const winner = a.wire?.accepted === true ? 'ios' : 'web';
    expect(append).toHaveBeenCalledWith('shared body', winner);
    expect(a.wire?.dedupeKey).toBe(b.wire?.dedupeKey);
    const [c, d] = await Promise.all([
      post(api, { text: 'body-c', source: 'ios' }),
      post(api, { text: 'body-d', source: 'web' }),
    ]);
    expect(c.wire?.accepted).toBe(true);
    expect(d.wire?.accepted).toBe(true);
    expect(append.mock.calls.slice(1)).toEqual(
      expect.arrayContaining([['body-c', 'ios'], ['body-d', 'web']]),
    );
  });

  it('invalidates cached inbox state only after accepted persistence', async () => {
    const append = vi.fn(okAppend());
    const readInbox = vi.fn(async () => []);
    const api = createFleetRunsApi(deps({ appendInbox: append, readInbox }));
    await get(api);
    expect(readInbox).toHaveBeenCalledTimes(1);
    await post(api, { text: 'fresh' });            // accepted -> invalidate
    await get(api);
    expect(readInbox).toHaveBeenCalledTimes(2);
    await post(api, { text: 'fresh' });            // duplicate -> keep cache
    await get(api);
    expect(readInbox).toHaveBeenCalledTimes(2);
    append.mockRejectedValueOnce(new Error('fake failure'));
    await post(api, { text: 'other' });            // failed append -> keep cache
    await get(api);
    expect(readInbox).toHaveBeenCalledTimes(2);
    await post(api, { text: 'other' });            // retry succeeds -> invalidate
    await get(api);
    expect(readInbox).toHaveBeenCalledTimes(3);
  });
});
