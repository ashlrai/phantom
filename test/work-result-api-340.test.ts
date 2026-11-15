/** POST /api/verse/fleet/work-board/result — the desktop "record result"
 * action posts the same evidence-shaped bus reply as `ashlr fleet
 * work-result`. A result receipt is evidence, not authority. Fake ids only. */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_WORK_BOARD_PATH as BOARD,
  VERSE_FLEET_WORK_RESULT_PATH as RESULT,
  WORK_RESULT_MAX_BODY_BYTES,
  createFleetWorkBoardApi,
  type FleetWorkBoardApiDeps,
} from '../src/core/verse/fleet-work-board-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { replyResult, type ReplyOutcome } from '../src/core/fleet/bus-reply-post.js';

const NOW = new Date('2026-11-14T04:00:00.000Z');
type Posted = { requestId: string; replyId: string; body: unknown };

function api(outcome: ReplyOutcome | (() => never) = 'posted', transport: string | null = null) {
  const calls: Posted[] = [];
  const postReply: FleetWorkBoardApiDeps['postReply'] = (requestId, replyId, body) => {
    calls.push({ requestId, replyId, body });
    if (typeof outcome === 'function') return outcome();
    return replyResult(outcome, transport ?? (outcome === 'posted' || outcome === 'duplicate' ? outcome : null));
  };
  const module = createFleetWorkBoardApi({
    read: () => ({ items: [], inbox: 'ok', truncated: false, claims: 'available' }),
    now: () => NOW,
    postReply,
  });
  return { module, calls };
}

async function call(module: ReturnType<typeof api>['module'], method: string, path: string, raw?: string) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: path }) as unknown as IncomingMessage;
  const pending = module({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, method);
  if (raw !== undefined) {
    // Let readBody attach its listeners, then stream the body.
    await Promise.resolve();
    req.emit('data', Buffer.from(raw, 'utf8'));
    req.emit('end');
  }
  const handled = await pending;
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const post = (module: ReturnType<typeof api>['module'], body: unknown) =>
  call(module, 'POST', RESULT, typeof body === 'string' ? body : JSON.stringify(body));

const valid = { requestId: 'req-fake-1', replyId: 'reply-fake-1', result: { pr: 42, head: 'deadbeef' } };

describe('POST work-board/result', () => {
  it('posted → 200 with the CLI reply shape and the shared evidence body', async () => {
    const { module, calls } = api('posted');
    const r = await post(module, valid);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(replyResult('posted', 'posted'));
    expect(calls).toEqual([{ requestId: 'req-fake-1', replyId: 'reply-fake-1', body: { verified: { pr: 42, head: 'deadbeef' } } }]);
  });

  it('duplicate → 200; each other form reaches the poster', async () => {
    const { module, calls } = api('duplicate');
    for (const result of [{ tests: 'vitest 9/9' }, { artifact: 'out/fake.tgz' }, { blocked: ' fake-dep ' }]) {
      const r = await post(module, { ...valid, result });
      expect(r.status).toBe(200);
      expect(r.body.outcome).toBe('duplicate');
    }
    expect(calls.map(c => c.body)).toEqual([
      { verified: { tests: 'vitest 9/9' } }, { verified: { artifact: 'out/fake.tgz' } }, { blocked: { dependency: 'fake-dep' } },
    ]);
  });

  it('invalid bodies → 400 without calling postReply', async () => {
    const { module, calls } = api('posted');
    const bad: unknown[] = [
      'not json', '[]', 'null',
      { ...valid, requestId: '' }, { ...valid, replyId: 7 }, { ...valid, requestId: 'x'.repeat(201) },
      { ...valid, replyId: 'reply-\nfake' }, { ...valid, requestId: 'req\u0000' },
      { ...valid, result: {} }, { ...valid, result: { tests: 'a', artifact: 'b' } },
      { ...valid, result: { pr: 1 } }, { ...valid, result: { pr: 0, head: 'h' } },
      { ...valid, result: { blocked: 'unknown' } }, { ...valid, result: { test: 'typo' } },
      { ...valid, result: 'tests' }, { requestId: 'req-fake-1', replyId: 'reply-fake-1' },
      { ...valid, root: '/tmp/elsewhere' },
    ];
    for (const body of bad) {
      const r = await post(module, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.outcome).toBe('invalid-input');
    }
    expect(calls).toEqual([]);
  });

  it('maps poster outcomes to status codes', async () => {
    expect((await post(api('invalid-input').module, valid)).status).toBe(400);
    expect((await post(api('request-not-found').module, valid)).status).toBe(404);
    expect((await post(api('transport-refused', 'conflict').module, valid)).status).toBe(409);
    expect((await post(api('transport-refused', 'retryable').module, valid)).status).toBe(503);
    expect((await post(api('transport-refused').module, valid)).status).toBe(503);
    const thrown = await post(api(() => { throw new Error(`boom ${process.env['HOME']}`); }).module, valid);
    expect(thrown.status).toBe(503);
    expect(thrown.body).toEqual(replyResult('transport-refused'));
  });

  it('oversize body → 413 without calling postReply', async () => {
    const { module, calls } = api('posted');
    const big = JSON.stringify({ ...valid, result: { tests: 'x'.repeat(WORK_RESULT_MAX_BODY_BYTES) } });
    const r = await post(module, big);
    expect(r.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('non-POST on /result → 405', async () => {
    const { module, calls } = api('posted');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const r = await call(module, method, RESULT);
      expect(r.handled).toBe(true);
      expect(r.status).toBe(405);
    }
    expect(calls).toEqual([]);
  });

  it('leaves GET /work-board answering and other subpaths unclaimed', async () => {
    const { module } = api('posted');
    const r = await call(module, 'GET', BOARD);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], inbox: 'ok', truncated: false, claims: 'available', asOf: NOW.toISOString() });
    expect((await call(module, 'POST', BOARD)).status).toBe(405);
    expect((await call(module, 'POST', `${RESULT}/extra`)).handled).toBe(false);
  });
});
