import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { approveCosTask, askCosTask, cosTaskLine, isCosRouteAbsent, readCosTask } from './cos-task-client.js';

const ID = 'cos-0123456789abcdef0123456789abcdef';
const DIGEST = 'sha256:0123456789abcdef01234567';
const token = 'a'.repeat(64);
beforeEach(() => setMutationToken(token));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

function stub(status: number, body: unknown) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('asks with the exact path and body', async () => {
  const fetcher = stub(201, { v: 1, id: ID, ack: 'Queued.', status: 'queued', duplicate: false });
  const result = await askCosTask('Reply to Sam');
  expect(result).toMatchObject({ id: ID, ack: 'Queued.', duplicate: false });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/verse/fleet/cos/ask');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ text: 'Reply to Sam' });
  expect(new Headers(init?.headers).get('x-ashlr-token')).toBe(token);
});

it('reads status by id', async () => {
  const fetcher = stub(200, { v: 1, id: ID, jobStatus: 'running', channel: 'email', draft: { text: 'Hi', digest: DIGEST }, delivery: null, needsYou: true });
  const status = await readCosTask(ID);
  expect(fetcher.mock.calls[0]![0]).toBe(`/api/verse/fleet/cos/status?id=${ID}`);
  expect(status.draft).toEqual({ text: 'Hi', digest: DIGEST });
});

it('approves with id and the unchanged digest, never text', async () => {
  const fetcher = stub(200, { v: 1, id: ID, delivery: 'sent' });
  await approveCosTask(ID, DIGEST);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/verse/fleet/cos/approve');
  const body = JSON.parse(String(init?.body));
  expect(body).toEqual({ id: ID, digest: DIGEST });
  expect(body).not.toHaveProperty('text');
});

it('words every state', () => {
  const draft = { text: 't', digest: DIGEST };
  expect(cosTaskLine({ jobStatus: 'queued', draft: null, delivery: null })).toMatch(/^Queued/);
  expect(cosTaskLine({ jobStatus: 'claimed', draft: null, delivery: null })).toBe('A worker is on it');
  expect(cosTaskLine({ jobStatus: 'running', draft: null, delivery: null })).toBe('A worker is on it');
  expect(cosTaskLine({ jobStatus: 'done', draft, delivery: null })).toMatch(/waiting for your approval/);
  expect(cosTaskLine({ jobStatus: 'done', draft, delivery: 'sent' })).toBe('Sent');
  expect(cosTaskLine({ jobStatus: 'done', draft, delivery: 'uncertain' })).toBe('Delivery uncertain; check the channel before any retry');
  expect(cosTaskLine({ jobStatus: 'weird', draft: null, delivery: null })).toBe('Status unknown');
});

it('flags an absent route', () => {
  expect(isCosRouteAbsent(new ApiError('x', 404, '/p', null, null))).toBe(true);
  expect(isCosRouteAbsent(new ApiError('x', 503, '/p', null, 'COS_UNAVAILABLE'))).toBe(true);
  expect(isCosRouteAbsent(new ApiError('x', 404, '/p', null, 'COS_UNKNOWN'))).toBe(false);
  expect(isCosRouteAbsent(new ApiError('x', 422, '/p', null, 'COS_REFUSED'))).toBe(false);
  expect(isCosRouteAbsent(new Error('x'))).toBe(false);
});
