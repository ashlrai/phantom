import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
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

it.each([['GET', '', true, 200], ['GET', '', false, 404], ['POST', '', true, 405],
  ['GET', '?limit=1', true, 400], ['GET', '?', true, 400]] as const)(
  'metadata %s %s with dispatch=%s returns %i without granting image access', async (method, query, allowDispatch, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'library-metadata-'));
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    try {
      const dir = join(root, 'inbox-attachments');
      await mkdir(dir);
      const file = join(dir, '0123456789abcdef.png');
      await writeFile(file, 'not shown');
      const time = new Date('2026-11-17T00:00:00.000Z');
      await utimes(file, time, time);
      const path = '/api/verse/leader/attachment-metadata';
      let code = 0;
      let body = '';
      const req = { url: path + query, headers: {} } as IncomingMessage;
      const res = { writeHead(n: number) { code = n; }, setHeader() {}, end(chunk: string) { body = chunk; } } as unknown as ServerResponse;
      expect(await handleLeaderApi({ token: 'test-token', allowDispatch } as VerseApiContext, req, res, path, method)).toBe(true);
      expect(code).toBe(expected);
      if (expected === 200) expect(JSON.parse(body)).toEqual({ state: 'ok', items: [{ name: '0123456789abcdef.png',
        bytes: 9, type: 'image/png', modifiedAt: time.toISOString() }] });
      expect(await status('/api/verse/leader/attachment/0123456789abcdef.png', '', true)).toBe(401);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  },
);
