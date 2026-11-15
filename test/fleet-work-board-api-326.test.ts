/** GET /api/verse/fleet/work-board — the desktop read of the shared work
 * board, same JSON shape as `ashlr fleet work-board --json`. Fake ids only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_WORK_BOARD_PATH as PATH,
  createFleetWorkBoardApi,
} from '../src/core/verse/fleet-work-board-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { ashlrHome } from '../src/core/cloud/store.js';
import {
  WORK_BOARD_DEFAULT_LIMIT,
  WORK_BOARD_MAX_LIMIT,
  type WorkBoardItem,
  type WorkBoardResult,
} from '../src/core/comms/work-board.js';
import { WORKBENCH_ROUTE_FAMILIES } from '../src/core/verse/workbench-types.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');

function item(i: number, over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: `wi-fake-${String(i).padStart(4, '0')}`, channel: 'slack',
    channelRef: 'fake-team/fake-chan/111.2', receivedAt: '2026-11-13T17:00:00.000Z',
    state: 'RUNNING', asOf: NOW.toISOString(), source: 'bus', missing: [],
    owner: 'devin', claimReceipt: `bus-claim:wi-fake-${i}:7:x`, ...over,
  };
}

function board(items: WorkBoardItem[], over: Partial<WorkBoardResult> = {}): WorkBoardResult {
  return { items, inbox: 'ok', truncated: false, claims: 'available', ...over };
}

async function call(api: ApiModule, method = 'GET', url = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api(
    { cfg: {}, allowDispatch: true } as VerseApiContext,
    { url } as IncomingMessage,
    res,
    // The dispatcher hands modules the pathname only; the query stays on req.url.
    url.split('?')[0]!,
    method,
  );
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet work-board api', () => {
  it('answers the CLI --json shape: board fields plus asOf', async () => {
    const r = await call(createFleetWorkBoardApi({ read: () => board([item(1), item(2)]), now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...board([item(1), item(2)]), asOf: NOW.toISOString() });
    expect(r.text).not.toContain('SECRET-BODY');
  });

  it('reads the server fleet root and the injected clock, never a caller root/path/cwd', async () => {
    let seen: { root?: string; now?: number; limit?: number; channelRef?: string } = {};
    const r = await call(
      createFleetWorkBoardApi({ read: (opts) => { seen = opts; return board([]); }, now: () => NOW }),
      'GET',
      `${PATH}?root=/tmp/evil&path=/etc&cwd=/x&limit=7`,
    );
    expect(r.status).toBe(200);
    expect(seen.root).toBe(join(ashlrHome(), 'fleet'));
    expect(seen.now).toBe(NOW.getTime());
    expect(seen.limit).toBe(7);
  });

  it('defaults limit to the board default and clamps integers into 1..MAX', async () => {
    const seen: number[] = [];
    const api = createFleetWorkBoardApi({ read: (opts) => { seen.push(opts.limit ?? -1); return board([]); }, now: () => NOW });
    await call(api, 'GET', PATH);
    await call(api, 'GET', `${PATH}?limit=1`);
    await call(api, 'GET', `${PATH}?limit=0`);
    await call(api, 'GET', `${PATH}?limit=-9`);
    await call(api, 'GET', `${PATH}?limit=${WORK_BOARD_MAX_LIMIT + 500}`);
    expect(seen).toEqual([WORK_BOARD_DEFAULT_LIMIT, 1, 1, 1, WORK_BOARD_MAX_LIMIT]);
  });

  it('rejects a non-integer limit with 400', async () => {
    const api = createFleetWorkBoardApi({ read: () => board([]), now: () => NOW });
    for (const bad of ['abc', '1.5', '', '20x']) {
      const r = await call(api, 'GET', `${PATH}?limit=${bad}`);
      expect(r.status, `limit=${bad}`).toBe(400);
      expect(r.body).toEqual({ error: 'limit must be an integer.' });
    }
  });

  it('passes an exact thread channel_ref through and refuses one over 200 chars', async () => {
    let channelRef: string | undefined;
    const api = createFleetWorkBoardApi({ read: (opts) => { channelRef = opts.channelRef; return board([]); }, now: () => NOW });
    const r = await call(api, 'GET', `${PATH}?thread=${encodeURIComponent('fake-team/fake-chan/111.2')}`);
    expect(r.status).toBe(200);
    expect(channelRef).toBe('fake-team/fake-chan/111.2');
    const long = await call(api, 'GET', `${PATH}?thread=${'x'.repeat(201)}`);
    expect(long.status).toBe(400);
  });

  it('rejects non-GET with 405 and ignores other paths', async () => {
    const api = createFleetWorkBoardApi({ read: () => board([]), now: () => NOW });
    const post = await call(api, 'POST');
    expect(post.handled).toBe(true);
    expect(post.status).toBe(405);
    expect(post.body).toEqual({ error: 'method not allowed' });
    expect((await call(api, 'GET', '/api/verse/fleet/other')).handled).toBe(false);
  });

  it('degrades to the board unavailable shape when the reader throws', async () => {
    const r = await call(createFleetWorkBoardApi({ read: () => { throw new Error(`boom ${process.env['HOME']}/ledger`); }, now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], inbox: 'unavailable', truncated: false, claims: 'unavailable', asOf: NOW.toISOString() });
    expect(r.text).not.toContain('boom');
    expect(r.text).not.toContain(process.env['HOME'] ?? 'HOME-NOT-SET');
  });

  it('passes the board unavailable inbox through unchanged', async () => {
    const r = await call(createFleetWorkBoardApi({ read: () => board([], { inbox: 'unavailable', claims: 'missing' }), now: () => NOW }));
    expect(r.body).toMatchObject({ inbox: 'unavailable', items: [], claims: 'missing' });
  });

  it('is registered exactly once in the workbench route table', () => {
    const rows = WORKBENCH_ROUTE_FAMILIES.filter(f => (f.prefixes as readonly string[]).includes(PATH));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: 'desktop-command', handler: 'handleFleetWorkBoardApi' });
  });
});
