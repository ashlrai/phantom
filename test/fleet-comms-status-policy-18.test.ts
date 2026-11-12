import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { ChannelId } from '../src/core/agents/channel-policy.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const team = [
  { channel: 'slack', id: 'team-id-fake-01' },
  { channel: 'imessage', id: 'team-id-fake-02' },
  { channel: 'slack', id: 'team-id-fake-03' },
] as const;
async function call(sendPolicy: () => { teamIdentities: { channel: ChannelId; id: string }[]; confirmedByMason: boolean }, method = 'GET') {
  const runsDir = await mkdtemp(join(tmpdir(), 'policy-card-'));
  const api = createFleetCommsStatusApi({ runsDir, sendPolicy });
  let text = ''; let code = 0;
  const res = { writeHead(c: number) { code = c; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as IncomingMessage, res, VERSE_FLEET_COMMS_STATUS_PATH, method);
  return { code, text, body: JSON.parse(text) };
}
it('reports a confirmed policy with sorted, de-duplicated channels', async () => {
  const r = await call(() => ({ teamIdentities: [...team], confirmedByMason: true }));
  expect(r.body.sendPolicy).toEqual({ confirmed: true, teamIdentities: 3, channels: ['imessage', 'slack'] });
  expect(r.body.sources.sendPolicy).toBe('healthy');
});
it('reports an unconfirmed policy', async () => {
  const r = await call(() => ({ teamIdentities: [...team], confirmedByMason: false }));
  expect(r.body.sendPolicy.confirmed).toBe(false);
});
it('reports zero team identities', async () => {
  const r = await call(() => ({ teamIdentities: [], confirmedByMason: false }));
  expect(r.body.sendPolicy).toEqual({ confirmed: false, teamIdentities: 0, channels: [] });
});
it('never leaks identity ids or the home path', async () => {
  const r = await call(() => ({ teamIdentities: [...team], confirmedByMason: true }));
  expect(r.text).not.toContain('team-id-fake');
  expect(r.text).not.toContain(homedir());
  expect(r.text).not.toContain('.ashlr/');
});
it('degrades when the reader throws, leaving the rest intact', async () => {
  const r = await call(() => { throw new Error('/home/secret/.ashlr'); });
  expect(r.body.sendPolicy).toBeNull();
  expect(r.body.sources.sendPolicy).toBe('degraded');
  expect(r.body.drafts).not.toBeUndefined();
  expect(r.text).not.toContain('secret');
});
it('still rejects non-GET methods with 405', async () => {
  for (const method of ['POST', 'PUT', 'PATCH']) {
    const r = await call(() => ({ teamIdentities: [], confirmedByMason: true }), method);
    expect(r.code).toBe(405);
  }
});
