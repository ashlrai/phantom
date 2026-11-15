import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { checkIMessagePath } from '../src/core/comms/imessage-path-check.js';
import type { AckEvidence } from '../src/core/comms/imessage-ack-evidence.js';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = new Date('2026-11-09T12:00:00.000Z');
const path = () => {
  const result = checkIMessagePath({ platform: 'darwin', probe: () => 'ok', cursor: () => 1 });
  result.configuration = { state: 'configured', reason: 'CONFIG_ENABLED', nextStep: 'inspect' };
  return result;
};
const evidence: AckEvidence = { sourceState: 'ok', rows: [
  { timestamp: '2026-11-09T11:56:00.000Z', rowid: 987654, status: 'accepted', delivery: 'recorded-not-sent' },
  { timestamp: '2026-11-07T11:56:00.000Z', rowid: 987655, status: 'duplicate', delivery: 'unknown' },
], malformedRows: 0, deliveryProof: false };
async function call(over: Partial<Parameters<typeof createFleetCommsStatusApi>[0]> = {}) {
  const runsDir = await mkdtemp(join(tmpdir(), 'imsg-card-'));
  const api = createFleetCommsStatusApi({ runsDir, now: () => now, imessagePath: path, imessageAcks: async () => evidence, ...over });
  let text = '';
  const res = { writeHead() { return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as IncomingMessage, res, VERSE_FLEET_COMMS_STATUS_PATH, 'GET');
  return { body: JSON.parse(text), text };
}
it('projects bounded ack evidence without identifiers', async () => {
  const result = await call();
  expect(result.body.imessage).toMatchObject({ chatDb: { state: 'readable' }, ackSource: 'ok', lastAckAt: '2026-11-09T11:56:00.000Z', acks24h: 1, nextStep: null });
  expect(result.text).not.toContain('987654');
  expect(result.text).not.toContain('rowid');
  expect(result.text).not.toContain('handle');
});
it('reports a blocked database and its next step', async () => {
  const result = await call({ imessagePath: () => ({ ...path(), chatDb: { state: 'unavailable', reason: 'DB_ACCESS_BLOCKED', nextStep: 'Review Full Disk Access.' } }) });
  expect(result.body.imessage).toMatchObject({ chatDb: { state: 'unavailable' }, nextStep: 'Review Full Disk Access.' });
});
it('reports missing ack evidence', async () => {
  const result = await call({ imessageAcks: async () => ({ ...evidence, sourceState: 'missing', rows: [] }) });
  expect(result.body.imessage).toMatchObject({ ackSource: 'missing', lastAckAt: null, acks24h: 0 });
});
it('degrades when a reader throws', async () => {
  const result = await call({ imessageAcks: async () => { throw new Error('private'); } });
  expect(result.body.imessage).toBeNull();
  expect(result.body.sources.imessage).toBe('degraded');
  expect(result.text).not.toContain('private');
});
