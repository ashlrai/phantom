import { mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';
const home = useTmpHome();
beforeEach(() => {
  home.setup();
  const dir = join(home.home(), '.ashlr', 'vision', 'leader');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'thread.jsonl'), ['release ready', 'other'].map((text, i) => JSON.stringify({ id: `lt-2026010100000${i}-000001`, at: `2026-01-01T00:00:0${i}Z`, from: 'leader', channel: 'cli', kind: 'message', text })).join('\n'), { mode: 0o600 });
});
afterEach(() => home.teardown());
async function get(url: string): Promise<{ status: number; body: { messages: { text: string }[] } }> {
  const req = Object.assign(Readable.from([]), { method: 'GET', url, headers: {} }) as unknown as IncomingMessage;
  let status = 0; let text = '';
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(chunk: string) { text = chunk; } } as unknown as ServerResponse;
  await handleLeaderApi({ cfg: {} as AshlrConfig, token: 'test', allowDispatch: false } as VerseApiContext, req, res, '/api/verse/leader/thread', 'GET');
  return { status, body: JSON.parse(text) };
}
it('filters the route and rejects an invalid channel', async () => {
  const result = await get('/api/verse/leader/thread?q=release');
  expect(result.status).toBe(200);
  expect(result.body.messages.map(m => m.text)).toEqual(['release ready']);
  expect((await get('/api/verse/leader/thread?channel=bad')).status).toBe(400);
});
