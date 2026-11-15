import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRouteReplyFacts } from '../src/core/fleet/order-thread-reply.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import { createFleetOrderStateApi, VERSE_FLEET_ORDER_STATE_PATH as PATH } from '../src/core/verse/fleet-order-state-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { orderRowView, parseOrderStateBody } from '../src/web-ui/routes/verse/fleet-board/order-state-model.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('recut #5687: persisted reply receipts through the order API and row model', () => {
  it('rereads delivery changes, preserves unknown on failure and excludes private route data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recut-fleetmz-'));
    roots.push(root);
    mkdirSync(join(root, 'leader'), { mode: 0o700 });
    const file = join(root, 'leader', 'network-state.json');
    const id = 'a'.repeat(64);
    const now = new Date('2026-11-14T12:00:00Z');
    const trace: OrderTraceV1 = {
      v: 1, generatedAt: now.toISOString(),
      sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
      orders: [{ at: '2026-11-14 11:00 ET', key: '11-14 11:00', source: 'slack', requestId: id, jobs: [] }],
    };
    const api = createFleetOrderStateApi({
      now: () => now, read: async () => trace,
      live: async () => ({ sourceState: 'healthy', workers: [], generatedAt: now.toISOString() }) as never,
      lanes: async () => { throw new Error('unavailable'); },
      replies: () => readRouteReplyFacts({ runsDir: root }),
    });
    const get = async () => {
      let body = ''; let status = 0;
      const res = {
        writeHead(code: number) { status = code; return this; },
        end(text: string) { body = text; },
      } as unknown as ServerResponse;
      expect(await api({} as VerseApiContext, { url: PATH } as IncomingMessage, res, PATH, 'GET')).toBe(true);
      expect(status).toBe(200);
      expect(body).not.toMatch(/private-route|private-reply|recipient|channelRef/);
      const parsed = parseOrderStateBody(JSON.parse(body));
      if (parsed.kind !== 'ok') throw new Error('order API unavailable');
      expect(parsed.rows[0]?.state).toBe('RECEIVED');
      return orderRowView(parsed.rows[0]!);
    };
    const save = (delivered: boolean) => writeFileSync(file, JSON.stringify({ version: 1, routes: {
      [id]: { recipient: 'private-route', reply: { text: 'private-reply', delivered, attempted: true } },
    } }), { mode: 0o600 });
    save(false);
    expect((await get()).replyText).toBe('reply attempted (unconfirmed)');
    save(true);
    expect((await get()).replyText).toBe('reply delivered');
    writeFileSync(file, '{malformed');
    expect((await get()).replyText).toBe('');
  });
});
