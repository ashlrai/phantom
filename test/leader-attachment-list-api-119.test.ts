import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function status(path: string, token: string, allowDispatch: boolean) {
  const req = Object.assign(Readable.from([]), { url: path, headers: { 'x-ashlr-token': token } }) as unknown as IncomingMessage;
  let code = 0;
  const res = { writeHead(n: number) { code = n; return this; }, setHeader() { return this; }, end() { return this; } } as unknown as ServerResponse;
  await handleLeaderApi({ token: 'test-token', allowDispatch } as VerseApiContext, req, res, path, 'GET');
  return code;
}
it('uses the same dispatch and token gate as the single image route', async () => {
  const list = '/api/verse/leader/attachments';
  const read = '/api/verse/leader/attachment/0123456789abcdef.png';
  expect(await status(list, '', false)).toBe(await status(read, '', false));
  expect(await status(list, '', true)).toBe(await status(read, '', true));
  expect(await status(list, '', true)).toBe(401);
  expect(await status(list, 'test-token', true)).toBe(200);
});
