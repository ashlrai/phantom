import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { handleLeaderApi, setLeaderApiHooksForTest } from '../src/core/verse/leader-api.js';
import { setLeaderThreadDepsForTest } from '../src/core/vision/leader-thread.js';
import { OWNER_STATUS_FALLBACK } from '../src/core/agents/owner-status-reply.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';

const readDigest = vi.hoisted(() => vi.fn());
vi.mock('../src/core/leader/status-digest-sources.js', () => ({ gatherStatusDigestInput: readDigest }));
vi.mock('../src/core/leader/status-digest.js', () => ({ buildStatusDigest: () => ['line one', 'line two', 'line three', 'line four', 'line five'] }));

/** composeSlackStatusReply (#5781, #5435) deliberately appends sanitized evidence lines after the
 * reply body; anything else after it is still a failure. */
const EVIDENCE_LINE = /^(Work items( as of |: )|Runtime: |Fleet state: |Claims: )/;
const evidenceOnly = (lines: string[]) => lines.every(l => EVIDENCE_LINE.test(l));

const home = useTmpHome();
const model = vi.fn(async () => { throw new Error('model seam called'); });
const token = 'test-token';
async function call(method: string, body?: unknown) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Object.assign(Readable.from(payload ? [Buffer.from(payload)] : []), {
    method, url: '/api/verse/leader/thread', headers: { 'content-type': 'application/json', 'x-ashlr-token': token },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; return this; }, setHeader() { return this; }, end(chunk?: string) { text += chunk ?? ''; return this; } };
  await handleLeaderApi({ cfg: {} as AshlrConfig, token, allowDispatch: true } as VerseApiContext, req, res as unknown as ServerResponse, '/api/verse/leader/thread', method);
  return { status, body: JSON.parse(text) };
}
beforeEach(() => {
  home.setup();
  readDigest.mockReset().mockResolvedValue({});
  model.mockClear();
  setLeaderApiHooksForTest({ plannerRunsRoot: () => join(home.home(), '.ashlr-runs') });
  setLeaderThreadDepsForTest({ loadRunDeps: model });
});
afterEach(() => { setLeaderApiHooksForTest({}); setLeaderThreadDepsForTest(null); home.teardown(); });

it('answers a short status ask from the digest and records both messages in order', async () => {
  const result = await call('POST', { text: 'Phantom status' });
  expect(result.status).toBe(200);
  const lines: string[] = result.body.reply.text.split('\n');
  expect(lines[0]).toMatch(/^Phantom status, .* ET$/);
  expect(lines.slice(1, 6)).toEqual(['line one', 'line two', 'line three', 'line four', 'line five']);
  expect(evidenceOnly(lines.slice(6))).toBe(true);
  expect(result.body.reply).toMatchObject({ channel: 'verse', replyTo: result.body.message.id });
  expect(result.body.reply.delivery).toBeUndefined();
  expect(model).not.toHaveBeenCalled();
  expect(readDigest).toHaveBeenCalledWith(join(home.home(), '.ashlr-runs'), expect.any(Date));
  const list = await call('GET');
  expect(list.body.messages.map((m: { id: string }) => m.id)).toEqual([result.body.message.id, result.body.reply.id]);
});

it('keeps specific status requests on the model path', async () => {
  await call('POST', { text: 'status of the release PR #12' });
  expect(model).toHaveBeenCalled();
  expect(readDigest).not.toHaveBeenCalled();
});

it('records the ask and replies with the fallback when the digest read fails', async () => {
  readDigest.mockRejectedValue(new Error('read failed'));
  const result = await call('POST', { text: 'Phantom status' });
  expect(result.status).toBe(200);
  const lines: string[] = result.body.reply.text.split('\n');
  expect(lines[0]).toBe(OWNER_STATUS_FALLBACK);
  expect(evidenceOnly(lines.slice(1))).toBe(true);
  expect(model).not.toHaveBeenCalled();
  const list = await call('GET');
  expect(list.body.messages.map((m: { id: string }) => m.id)).toEqual([result.body.message.id, result.body.reply.id]);
});
