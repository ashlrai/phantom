import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { summarizeTeammateLatency } from '../src/core/comms/teammate-reply-latency.js';
import type { TeammateRow } from '../src/core/comms/imessage-teammate-inbox.js';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = new Date('2026-11-09T12:00:00.000Z');
const rows = [
  { rowid: 424242, at: '2026-11-09T11:00:00.000Z', text: 'MARKER-TEXT-ONE can you check this?', handle: '+15550000000' },
  { rowid: 424243, at: '2026-11-09T11:30:00.000Z', text: 'MARKER-TEXT-TWO please look?', handle: '+15550000000' },
  { answered: 424242, at: '2026-11-09T11:02:00.000Z' },
] as unknown as TeammateRow[];

async function call(over: Partial<Parameters<typeof createFleetCommsStatusApi>[0]> = {}) {
  const runsDir = await mkdtemp(join(tmpdir(), 'teammate-card-'));
  const api = createFleetCommsStatusApi({ runsDir, now: () => now, ...over });
  let text = '';
  const res = { writeHead() { return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as IncomingMessage, res, VERSE_FLEET_COMMS_STATUS_PATH, 'GET');
  return { body: JSON.parse(text), text };
}

it('sends teammate counts and minutes, never text, senders or rowids', async () => {
  const { body, text } = await call({ teammateLatency: (at) => summarizeTeammateLatency(rows, { now: at }) });
  expect(body.teammate).toMatchObject({
    texts: 2, answered: 1, unanswered: 1, medianMinutes: 2, withinTarget: 1,
    oldestUnanswered: { ageMinutes: 30 }, latestTextAt: '2026-11-09T11:30:00.000Z', sourceState: 'healthy',
  });
  expect(body.sources.teammate).toBe('healthy');
  for (const secret of ['MARKER-TEXT', '+1555', 'handle', 'rowid', '424242', '424243']) expect(text).not.toContain(secret);
  for (const field of ['version', 'generatedAt', 'drafts', 'emailOutbox', 'emailDiagnosis', 'imessage']) expect(body).toHaveProperty(field);
  expect(body.sources).toMatchObject({ drafts: expect.any(String), emailOutbox: expect.any(String), imessage: expect.any(String) });
});

it('uses the request clock for the default reader', async () => {
  const seen: number[] = [];
  await call({ teammateLatency: (at) => { seen.push(at); return summarizeTeammateLatency([], { now: at }); } });
  expect(seen).toEqual([now.getTime()]);
});

it('reports a throwing source as null and degraded', async () => {
  const { body } = await call({ teammateLatency: () => { throw new Error('boom'); } });
  expect(body.teammate).toBeNull();
  expect(body.sources.teammate).toBe('degraded');
  expect(body.version).toBe(1);
});

it('reports a rejecting source as null and degraded', async () => {
  const { body } = await call({ teammateLatency: async () => { throw new Error('boom'); } });
  expect(body.teammate).toBeNull();
  expect(body.sources.teammate).toBe('degraded');
});
