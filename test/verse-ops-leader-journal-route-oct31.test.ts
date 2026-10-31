import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { VERSE_OPS_LEADER_JOURNAL_PATH } from '../src/core/fleet/leader-journal.js';
import { createOpsApi } from '../src/core/verse/ops-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function request(url: string, method = 'GET') {
  const req = Readable.from([]) as IncomingMessage;
  req.url = url; req.method = method; req.headers = {};
  let status = 0; let body: unknown;
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as ServerResponse;
  const handled = await createOpsApi()({ allowDispatch: true } as VerseApiContext, req, res, url.split('?')[0], method);
  return { handled, status, body };
}
describe('ops leader journal route', () => {
  it('returns a versioned journal', async () => {
    expect(await request(VERSE_OPS_LEADER_JOURNAL_PATH)).toMatchObject({ handled: true, status: 200, body: { v: 1 } });
  });
  it('rejects unknown query parameters', async () => {
    expect(await request(`${VERSE_OPS_LEADER_JOURNAL_PATH}?x=1`)).toMatchObject({ handled: true, status: 400 });
  });
  it('does not handle POST', async () => {
    expect((await request(VERSE_OPS_LEADER_JOURNAL_PATH, 'POST')).handled).toBe(false);
  });
});
