/** GET /api/verse/fleet/comms-status — the slackReplies request-to-receipt field. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import type { SlackBridgeStatus } from '../src/core/agents/slack-status.js';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH as PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

type Replies = SlackBridgeStatus['replies'];

async function call(slackReplies: () => Replies) {
  const api = createFleetCommsStatusApi({
    runsDir: await mkdtemp(join(tmpdir(), 'slack-replies-')),
    now: () => new Date('2026-11-13T12:00:00.000Z'),
    channelHealth: async () => ({ schemaVersion: 1, asOf: '2026-11-13T12:00:00.000Z', channels: [] }),
    slackReplies,
  });
  let status = 404, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as IncomingMessage, res, PATH, 'GET');
  return { status, body: JSON.parse(text), text };
}

const row = (n: number) => ({
  channelId: 'C0FAKE0001', threadTs: `1731000000.00${String(n).padStart(4, '0')}`,
  messageTs: `1731000001.00${String(n).padStart(4, '0')}`, at: `2026-11-13T11:0${n}:00.000Z`,
});
const replies = (over: Partial<Replies>): Replies => ({
  state: 'ok', answered: 0, unanswered: 0, oldestUnansweredAt: null, uncertainSends: 0,
  rejected: 0, futureDated: 0, unansweredSample: [], ...over,
});

it('carries counts, oldest time and sample rows without messageTs', async () => {
  const { status, body, text } = await call(() => replies({
    answered: 1, unanswered: 2, uncertainSends: 1, oldestUnansweredAt: row(1).at, unansweredSample: [row(1), row(2)],
  }));
  expect(status).toBe(200);
  expect(body.slackReplies).toEqual({
    state: 'ok', answered: 1, unanswered: 2, oldestUnansweredAt: row(1).at, uncertainSends: 1,
    sample: [
      { channelId: 'C0FAKE0001', threadTs: row(1).threadTs, at: row(1).at },
      { channelId: 'C0FAKE0001', threadTs: row(2).threadTs, at: row(2).at },
    ],
  });
  expect(body.sources.slackReplies).toBe('healthy');
  expect(text).not.toContain('messageTs');
  expect(text).not.toContain('1731000001');
});

it('caps the sample at 5 rows', async () => {
  const many = [1, 2, 3, 4, 5, 6, 7].map(row);
  const { body } = await call(() => replies({ unanswered: 7, unansweredSample: many }));
  expect(body.slackReplies.sample).toHaveLength(5);
  expect(body.slackReplies.unanswered).toBe(7);
});

it('drops sample rows whose ids are not shaped like Slack ids', async () => {
  const bad = { ...row(1), channelId: '/Users/someone/secret' };
  const { body } = await call(() => replies({ unanswered: 2, unansweredSample: [bad, row(2)] }));
  expect(body.slackReplies.sample.map((s: { threadTs: string }) => s.threadTs)).toEqual([row(2).threadTs]);
});

it('degrades to null on a throw without failing the route', async () => {
  const { status, body } = await call(() => { throw new Error('boom'); });
  expect(status).toBe(200);
  expect(body.slackReplies).toBeNull();
  expect(body.sources.slackReplies).toBe('degraded');
  expect(body.version).toBe(1);
  expect(body.channelHealth.channels).toEqual([]);
});

it('passes state missing through unchanged', async () => {
  const { body } = await call(() => replies({ state: 'missing' }));
  expect(body.slackReplies).toMatchObject({ state: 'missing', answered: 0, unanswered: 0, sample: [] });
  expect(body.sources.slackReplies).toBe('healthy');
});
