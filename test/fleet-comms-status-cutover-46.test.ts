import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import type { CommsCutoverReport } from '../src/core/comms/cutover-readiness.js';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = new Date('2026-11-09T12:00:00.000Z');
const cap = (state: string, reason: string) => ({ state, reason, nextStep: 'phm fleet comms-readiness', counts: { queued: 1 } });
const report = {
  schema: 'fleet.comms-cutover-readiness.v1',
  coverage: 'local-evidence-only-not-delivery-proof',
  capabilities: { emailPolling: cap('ready', 'email-polling-enabled'), linkedin: cap('unverified', 'no-local-evidence-for-linkedin') },
  overall: { state: 'incomplete', blockers: ['linkedin'], commsbotRetirement: 'not-evidenced', nextStep: 'phm fleet comms-readiness' },
} as unknown as CommsCutoverReport;

async function call(over: Partial<Parameters<typeof createFleetCommsStatusApi>[0]> = {}) {
  const runsDir = await mkdtemp(join(tmpdir(), 'cutover-card-'));
  const api = createFleetCommsStatusApi({ runsDir, now: () => now, ...over });
  let text = '';
  const res = { writeHead() { return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as IncomingMessage, res, VERSE_FLEET_COMMS_STATUS_PATH, 'GET');
  return JSON.parse(text);
}

it('projects the cutover report without counts', async () => {
  const seen: string[] = [];
  const body = await call({ cutover: async (dir) => { seen.push(dir); return report; } });
  expect(seen).toHaveLength(1);
  expect(body.cutover).toEqual({
    overall: { state: 'incomplete', blockers: ['linkedin'] },
    capabilities: {
      emailPolling: { state: 'ready', reason: 'email-polling-enabled', nextStep: 'phm fleet comms-readiness' },
      linkedin: { state: 'unverified', reason: 'no-local-evidence-for-linkedin', nextStep: 'phm fleet comms-readiness' },
    },
  });
  expect(JSON.stringify(body.cutover)).not.toContain('counts');
  expect(body.sources.cutover).toBe('healthy');
});

it('reports a throwing seam as null and degraded, leaving other fields alone', async () => {
  const ok = await call({ cutover: async () => report });
  const bad = await call({ cutover: async () => { throw new Error('boom'); } });
  expect(bad.cutover).toBeNull();
  expect(bad.sources.cutover).toBe('degraded');
  const { cutover: _c, ...okRest } = ok;
  const { cutover: _d, ...badRest } = bad;
  expect({ ...badRest, sources: { ...badRest.sources, cutover: undefined } })
    .toEqual({ ...okRest, sources: { ...okRest.sources, cutover: undefined } });
});
