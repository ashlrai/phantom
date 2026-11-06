import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { parseIncidentLines } from '../src/core/fleet/operator-glance.js';
import { hideResolvedNeedsMason, listNeedsMason, resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let home = '';
let opts: { runsDir: string; bus: { root: string; now: () => number }; now: () => number };
const NOW = 1_800_000_000_000;
const events = () => listBusInboxAfter(0, 100, opts.bus);
const busBodies = () => { const page = events(); return page.status === 'ok' ? page.messages.map(m => m.envelope.body as Record<string, unknown>) : []; };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fake-needs-mason-'));
  mkdirSync(join(home, 'runs'));
  writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] Approve the fake deploy\n- Pick a fake vendor\n- [x] old thing\n');
  opts = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now: () => NOW }, now: () => NOW };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('resolveNeedsMason', () => {
  it('publishes one needs_mason.resolved event and the reader stops listing the item', () => {
    const [first, second] = listNeedsMason(opts);
    expect(first!.text).toBe('Approve the fake deploy');
    const result = resolveNeedsMason({ itemId: first!.id, reply: 'go ahead\nsecond line' }, opts);
    expect(result).toMatchObject({ ok: true, itemId: first!.id, cursor: 1 });
    expect(busBodies()).toEqual([{ kind: 'needs_mason.resolved', itemId: first!.id, source: 'desktop',
      item: 'Approve the fake deploy', reply: 'go ahead second line', resolvedAt: new Date(NOW).toISOString() }]);
    expect(listNeedsMason(opts)).toEqual([second]);
    const file = readFileSync(join(opts.runsDir, 'NEEDS-MASON.md'), 'utf8');
    expect(file).not.toContain('go ahead');
    expect(parseIncidentLines(hideResolvedNeedsMason(file))).toEqual(['Pick a fake vendor']);
  });

  it('refuses an unknown id with no bus event', () => {
    expect(resolveNeedsMason({ itemId: 'nm-000000000000' }, opts)).toMatchObject({ ok: false, code: 'unknown' });
    expect(resolveNeedsMason({ itemId: 'nope' }, opts)).toMatchObject({ ok: false, code: 'invalid' });
    expect(busBodies()).toEqual([]);
  });

  it('refuses a repeat resolve without a second event', () => {
    const [item] = listNeedsMason(opts);
    expect(resolveNeedsMason({ itemId: item!.id }, opts)).toMatchObject({ ok: true });
    expect(resolveNeedsMason({ itemId: item!.id }, opts)).toMatchObject({ ok: false, code: 'already-resolved' });
    expect(busBodies()).toHaveLength(1);
  });

  it('refuses a 501-char reply and accepts 500', () => {
    const [item] = listNeedsMason(opts);
    expect(resolveNeedsMason({ itemId: item!.id, reply: 'x'.repeat(501) }, opts)).toMatchObject({ ok: false, code: 'reply-too-long' });
    expect(busBodies()).toEqual([]);
    expect(listNeedsMason(opts)).toHaveLength(2);
    expect(resolveNeedsMason({ itemId: item!.id, reply: 'x'.repeat(500) }, opts)).toMatchObject({ ok: true });
  });
});

describe('agent-bus needs-mason routes', () => {
  async function call(url: string, method: string, body?: unknown, o: { token?: string; dispatch?: boolean } = {}) {
    const handler = createAgentBusApi({ needsMason: { list: () => listNeedsMason(opts), resolve: input => resolveNeedsMason(input, opts) } });
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
    req.url = url; req.method = method;
    req.headers = { 'content-type': 'application/json', ...(o.token ? { 'x-ashlr-token': o.token } : {}) };
    let status = 0, wire: Record<string, unknown> = {};
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
      end(text: string) { wire = JSON.parse(text) as Record<string, unknown>; } } as unknown as ServerResponse;
    const ctx = { cfg: {}, token: 'fake-mutation-token', allowDispatch: o.dispatch ?? true,
      readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    await handler(ctx, req, res, url, method);
    return { status, wire };
  }

  it('lists, then resolves through the real handler behind the mutation gate', async () => {
    const listed = await call('/api/verse/agent-bus/needs-mason', 'GET');
    const items = listed.wire.items as Array<{ id: string }>;
    expect(items).toHaveLength(2);
    const path = '/api/verse/agent-bus/needs-mason/resolve';
    expect((await call(path, 'POST', { itemId: items[0]!.id }, { dispatch: false, token: 'fake-mutation-token' })).status).toBe(404);
    expect((await call(path, 'POST', { itemId: items[0]!.id })).status).toBeGreaterThanOrEqual(400);
    expect(busBodies()).toEqual([]);
    expect(await call(path, 'POST', { itemId: items[0]!.id, reply: 'ok' }, { token: 'fake-mutation-token' })).toMatchObject({ status: 200, wire: { status: 'resolved' } });
    expect((await call(path, 'POST', { itemId: items[0]!.id }, { token: 'fake-mutation-token' })).status).toBe(409);
    expect((await call(path, 'POST', { itemId: 'nm-000000000000' }, { token: 'fake-mutation-token' })).status).toBe(404);
    expect(busBodies()).toHaveLength(1);
  });
});
