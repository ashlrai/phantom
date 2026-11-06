import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { enqueueFrictionFlag, parseFrictionFlag } from '../src/core/verse/feedback-queue.js';
import { handleApi } from '../src/core/web/api.js';
import type { AshlrConfig } from '../src/core/types.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phantom-friction-'));
  vi.stubEnv('HOME', root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('appends distinct well-formed data-only lines concurrently with private permissions', async () => {
  const description = 'focus lost\nRQ-injected $(touch ' + join(root, 'PWNED') + '); `echo nope`';
  const receipts = await Promise.all(Array.from({ length: 12 }, () => enqueueFrictionFlag({ description, surface: 'chat' }, root)));
  const queue = join(root, 'feedback.jsonl');
  const raw = await readFile(queue, 'utf8');
  expect(raw.endsWith('\n')).toBe(true);
  const entries = raw.trim().split('\n').map((line) => JSON.parse(line));
  expect(entries).toHaveLength(12);
  expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(12);
  for (const entry of entries) {
    expect(entry).toMatchObject({ v: 1, repo: 'phantom', tier: 'work', lead: 'Adoption', flag: 'agentWorkspace', source: 'desktop-feedback', description, surface: 'chat' });
    expect(entry.id).toMatch(/^RQ-DESKTOP-FRICTION-[a-f0-9-]{36}$/);
    expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
  }
  if (process.platform !== 'win32') expect((await stat(queue)).mode & 0o777).toBe(0o600);
  await expect(stat(join(root, 'PWNED'))).rejects.toThrow();
});

it.each([null, [], {}, { description: ' ', surface: 'chat' },
  { description: 'x'.repeat(2001), surface: 'chat' },
  { description: 'x', surface: '../escape' },
  { description: 'x', surface: 'chat', path: '/tmp/escape' },
  { description: 'x', surface: 'chat', command: 'echo nope' },
])('rejects malformed or authority-bearing input: %j', (value) => {
  expect(() => parseFrictionFlag(value)).toThrow('Invalid flag');
});

it('refuses a symlink destination without modifying its target', async () => {
  const target = join(root, 'target');
  await writeFile(target, 'unchanged');
  await symlink(target, join(root, 'feedback.jsonl'));
  await expect(enqueueFrictionFlag({ description: 'x', surface: 'chat' }, root)).rejects.toThrow();
  expect(await readFile(target, 'utf8')).toBe('unchanged');
});

async function request(body: string, options: { allowDispatch?: boolean; method?: string; headers?: Record<string, string> } = {}) {
  const req = Readable.from([body]) as IncomingMessage;
  req.url = '/api/verse/feedback';
  req.method = options.method ?? 'POST';
  req.headers = options.headers ?? headers;
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { payload = value; },
  } as unknown as ServerResponse;
  expect(await handleApi(req, res, {} as AshlrConfig, { allowDispatch: options.allowDispatch ?? true, token: 'local-test-proof' })).toBe(true);
  return { status, body: JSON.parse(payload) };
}
const headers = { 'content-type': 'application/json', 'x-ashlr-token': 'local-test-proof' };
const body = JSON.stringify({ description: 'The panel steals focus', surface: 'chat' });

it('persists an authenticated flag and refuses unauthorized and invalid requests', async () => {
  expect((await request(body, { headers: { 'content-type': 'application/json' } })).status).toBe(401);
  expect((await request(body, { headers: { ...headers, 'content-type': 'text/plain' } })).status).toBe(415);
  expect((await request('{}')).status).toBe(400);
  expect((await request('{invalid')).status).toBe(400);
  expect((await request('x'.repeat(16 * 1024 + 1))).status).toBe(400);
  expect((await request(body, { method: 'GET' })).status).toBe(404);
  const response = await request(body);
  expect(response.status).toBe(201);
  const entries = (await readFile(join(root, '.ashlr/router/feedback.jsonl'), 'utf8')).trim().split('\n');
  expect(entries).toHaveLength(1);
  expect(JSON.parse(entries[0])).toMatchObject({ id: response.body.id, description: 'The panel steals focus' });
});

it('does not write when dispatch is disabled', async () => {
  expect((await request(body, { allowDispatch: false })).status).toBe(404);
  await expect(stat(join(root, '.ashlr/router/feedback.jsonl'))).rejects.toThrow();
});

it('reports a failed local write without returning a receipt', async () => {
  await writeFile(join(root, '.ashlr'), 'blocked');
  const response = await request(body);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'Could not save the flag locally. Try again.' });
});
