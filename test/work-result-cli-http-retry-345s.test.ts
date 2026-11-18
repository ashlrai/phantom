/** Cross-surface result retry (RQ-PHX-RESULTCROSSSURFACERETRY345S): the CLI
 * `ashlr fleet work-result` and the desktop POST /api/verse/fleet/work-board/result
 * both post through the real postBusReply into one real durable bus store.
 * Whichever surface lands second must observe a duplicate, so exactly one
 * reply is ever stored. Fake ids, a temp root and a controlled clock only;
 * no network, no Slack, no real ~/.ashlr. A result receipt is evidence, not
 * authority: the claims table must come out byte-for-byte unchanged. */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply, type ReplyResult } from '../src/core/fleet/bus-reply-post.js';
import { readBusInboxEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard, type WorkBoardItem } from '../src/core/comms/work-board.js';
import {
  VERSE_FLEET_WORK_BOARD_PATH as BOARD,
  VERSE_FLEET_WORK_RESULT_PATH as RESULT,
  createFleetWorkBoardApi,
} from '../src/core/verse/fleet-work-board-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const REQ = 'RQ-PHX-FAKE-345S';
const OTHER = 'RQ-PHX-FAKE-345S-OTHER';
const REPLY = 'fake-reply-345s';
const OTHER_REPLY = 'fake-reply-345s-other';
const OWNER = 'fake-owner-345s';
const T0 = Date.parse('2026-11-14T04:00:00.000Z');
const VERIFIED_BODY = { verified: { pr: 42, head: 'deadbeef' }, inReplyTo: REQ };

let root: string;
let clock: number;
const now = () => clock;
const iso = (ms: number) => new Date(ms).toISOString();
const claimsFile = () => join(root, 'bus-work-claims', 'claims.json');

function seedRequest(id: string): void {
  const posted = appendBusInbox({ id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 10_000_000,
    body: { kind: 'work' } }, { root, now });
  expect(posted.status).toBe('posted');
}

/** Surface A: the CLI, through the real cmdFleetWorkResult and its JSON line. */
async function viaCli(replyId: string, result: string[], requestId = REQ): Promise<{ code: number; reply: ReplyResult }> {
  const lines: string[] = [];
  const code = await cmdFleetWorkResult(
    ['--request-id', requestId, '--reply-id', replyId, ...result, '--root', root, '--json'],
    { now },
    { output: text => lines.push(text) },
  );
  return { code, reply: JSON.parse(lines.at(-1)!) as ReplyResult };
}

/** Surface B: the desktop board module, with a postReply adapter to the real
 * postBusReply for the same root. A fresh module per call = a reconstructed reader. */
function boardApi() {
  return createFleetWorkBoardApi({
    read: opts => listWorkBoard({ ...opts, root }),
    now: () => new Date(clock),
    postReply: (requestId, replyId, body) => postBusReply(requestId, replyId, body, { root, now }),
  });
}

async function http(method: string, path: string, raw?: string): Promise<{ status: number; body: any }> {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: path }) as unknown as IncomingMessage;
  const pending = boardApi()({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, method);
  if (raw !== undefined) {
    await Promise.resolve();
    req.emit('data', Buffer.from(raw, 'utf8'));
    req.emit('end');
  }
  await pending;
  return { status, body: text ? JSON.parse(text) : null };
}

const postHttp = (replyId: string, result: unknown, requestId = REQ) =>
  http('POST', RESULT, JSON.stringify({ requestId, replyId, result }));

async function boardItem(id: string): Promise<WorkBoardItem | undefined> {
  const r = await http('GET', BOARD);
  expect(r.status).toBe(200);
  return (r.body.items as WorkBoardItem[]).find(item => item.id === id);
}

/** Every retained reply carrying this reply id, read from the real inbox. */
function storedReplies(replyId: string): BusInboxReceipt[] {
  return readBusInboxEvidence(root).receipts.filter(row => row.envelope.id === replyId);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-result-retry-345s-'));
  chmodSync(root, 0o700);
  clock = T0;
  // Claim acquisition reads Date.now() directly; pin it to the controlled clock.
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('work result: CLI then desktop, and desktop then CLI, into one durable store', { timeout: 60_000 }, () => {
  const ORDERS = [
    { name: 'CLI first, desktop retry', first: 'cli', second: 'http' },
    { name: 'desktop first, CLI retry', first: 'http', second: 'cli' },
  ] as const;

  async function submit(surface: 'cli' | 'http', replyId: string): Promise<ReplyResult> {
    if (surface === 'cli') return (await viaCli(replyId, ['--pr', '42', '--head', 'deadbeef'])).reply;
    const r = await postHttp(replyId, { pr: 42, head: 'deadbeef' });
    expect(r.status).toBe(200);
    return r.body as ReplyResult;
  }

  for (const order of ORDERS) {
    it(`${order.name}: posted then duplicate, one stored reply, identical evidence`, async () => {
      seedRequest(REQ);
      const acquired = mutateBusWorkClaim({ action: 'acquire', id: REQ, owner: OWNER, leaseMs: 600_000, root });
      expect(acquired.status).toBe('acquired');
      const claimsBefore = readFileSync(claimsFile());

      clock = T0 + 1_000;
      const first = await submit(order.first, REPLY);
      expect(first).toMatchObject({ outcome: 'posted', transport: 'posted' });
      const boardAfterFirst = await http('GET', BOARD);

      clock = T0 + 2_000;
      const second = await submit(order.second, REPLY);
      expect(second).toMatchObject({ outcome: 'duplicate', transport: 'duplicate' });
      const boardAfterSecond = await http('GET', BOARD);

      // Exactly one stored reply, with the evidence body the board reads.
      const replies = storedReplies(REPLY);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.envelope.body).toEqual(VERIFIED_BODY);
      expect(replies[0]!.envelope.from).toBe('fake-lane');
      expect(replies[0]!.envelope.to).toBe('fake-requester');

      // The duplicate changes no evidence: both reconstructed board reads match.
      // Only the reader's own read stamp (top-level asOf) may differ between reads.
      expect({ ...boardAfterSecond.body, asOf: null }).toEqual({ ...boardAfterFirst.body, asOf: null });
      const item = (boardAfterSecond.body.items as WorkBoardItem[]).find(i => i.id === REQ);
      expect(item).toEqual({
        id: REQ, channel: 'bus', channelRef: null, receivedAt: iso(T0), state: 'VERIFIED',
        asOf: iso(T0 + 1_000), source: `bus-reply:${REPLY}`, missing: [], owner: OWNER,
        claimReceipt: `bus-claim:${REQ}:1:${T0}`,
        result: { kind: 'verified', pr: 42, head: 'deadbeef', tests: null, artifact: null },
      });

      // Receipt insertion neither completes nor releases the claim.
      expect(readFileSync(claimsFile())).toEqual(claimsBefore);
      const [claim] = inspectBusWorkClaims(root).claims;
      expect(claim).toMatchObject({ id: REQ, owner: OWNER, completedAt: null, leaseUntil: T0 + 600_000 });
    });
  }

  it('a changed body under the same reply id is refused with 409 on the desktop and exit 4 on the CLI; evidence preserved', async () => {
    seedRequest(REQ);
    clock = T0 + 1_000;
    expect((await submit('cli', REPLY)).outcome).toBe('posted');
    const before = await boardItem(REQ);

    clock = T0 + 2_000;
    const changed = await postHttp(REPLY, { pr: 43, head: 'cafef00d' });
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual({ schema: 'fleet.bus-reply.v1', correlation: 'untrusted-routing-only', outcome: 'transport-refused', transport: 'conflict' });

    const cliChanged = await viaCli(REPLY, ['--tests', 'vitest 0/9']);
    expect(cliChanged.code).toBe(4);
    expect(cliChanged.reply).toMatchObject({ outcome: 'transport-refused', transport: 'conflict' });

    const replies = storedReplies(REPLY);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.envelope.body).toEqual(VERIFIED_BODY);
    expect(await boardItem(REQ)).toEqual(before);
  });

  it('a distinct request does not acquire the result; its own result stays its own', async () => {
    seedRequest(REQ);
    seedRequest(OTHER);
    clock = T0 + 1_000;
    expect((await submit('http', REPLY)).outcome).toBe('posted');

    const other = await boardItem(OTHER);
    expect(other).toBeDefined();
    expect(other!.state).not.toBe('VERIFIED');
    expect(other!.result).toBeUndefined();
    expect(other!.source).not.toContain(REPLY);
    expect((await boardItem(REQ))!.state).toBe('VERIFIED');

    // The same result on a distinct request id is its own reply, not a duplicate of REPLY.
    clock = T0 + 2_000;
    expect((await postHttp(OTHER_REPLY, { tests: 'vitest 9/9' }, OTHER)).body.outcome).toBe('posted');
    expect(storedReplies(OTHER_REPLY)[0]!.envelope.body).toEqual({ verified: { tests: 'vitest 9/9' }, inReplyTo: OTHER });
    expect(storedReplies(REPLY)).toHaveLength(1);
    expect((await boardItem(REQ))!.result).toEqual({ kind: 'verified', pr: 42, head: 'deadbeef', tests: null, artifact: null });
  });

  it('an unknown request is refused on both surfaces and stores nothing', async () => {
    clock = T0 + 1_000;
    const cli = await viaCli(REPLY, ['--pr', '42', '--head', 'deadbeef'], 'RQ-PHX-FAKE-MISSING');
    expect(cli.code).toBe(3);
    expect(cli.reply.outcome).toBe('request-not-found');
    const http404 = await postHttp(REPLY, { pr: 42, head: 'deadbeef' }, 'RQ-PHX-FAKE-MISSING');
    expect(http404.status).toBe(404);
    expect(storedReplies(REPLY)).toEqual([]);
  });
});

describe('postBusReply retry reads the retained request, not the caller clock', () => {
  it('a retry after the request expired is refused rather than posting a second reply', () => {
    expect(appendBusInbox({ id: REQ, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 5_000,
      body: { kind: 'work' } }, { root, now }).status).toBe('posted');
    clock = T0 + 1_000;
    expect(postBusReply(REQ, REPLY, { verified: { tests: 'vitest' } }, { root, now }).outcome).toBe('posted');
    clock = T0 + 10_000;
    expect(postBusReply(REQ, REPLY, { verified: { tests: 'vitest' } }, { root, now }).outcome).toBe('request-not-found');
    expect(storedReplies(REPLY)).toHaveLength(1);
  });
});
