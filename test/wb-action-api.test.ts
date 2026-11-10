import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleWbAction, storeWbToken } from '../src/core/web/wb-action-api.js';
import { handleApi } from '../src/core/web/api.js';
import { QueueStore } from '../src/core/queue/store.js';
vi.mock('../src/core/inbox/temp-worktree-reaper.js', () => ({ reclaimableTempWorktrees: () => ({ paths: ['/private/fixture-one', '/private/fixture-two'], complete: true }) }));
let root: string;
let enabled: boolean;
let nonce = 0;
const token = 'fixture-mutation-capability';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-actions-'));
  enabled = true;
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue', 'slots.json'), JSON.stringify({ codex: { target: 2, floor: 0, ceiling: 4 } }));
  await new QueueStore(join(root, 'queue')).add({ id: 'FIXUP-ashlr-md-431d697', status: 'READY', priority: 'P0', pool: 'codex', tier: 'work', repo: 'phantom', deps: [], scope: 'fixture', acceptance: '', claims: [] });

});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function request(body: unknown, headers: Record<string, string> = {}, method = 'POST', throughApi = false) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.method = method;
  req.headers = { 'x-ashlr-token': token, 'content-type': 'application/json', ...headers };
  let status = 0;
  let payload = '';
  const res = { writeHead(code: number) { status = code; }, end(text: string) { payload = text; } } as unknown as ServerResponse;
  if (throughApi) {
    req.url = '/api/wb/v1/action';
    await handleApi(req, res, {} as Parameters<typeof handleApi>[2], { token, allowDispatch: enabled });
  } else await handleWbAction(req, res, { token, allowDispatch: enabled }, { directory: join(root, 'wb'), runsDir: root });
  return { status, text: async () => payload, json: async () => JSON.parse(payload) };
}
const body = (action: string, rest = {}) => ({ action, nonce: (++nonce).toString(16).padStart(32, '0'), ...rest });
it('refuses disabled, wrong method, read authority, and wrong content type', async () => {
  expect((await request({}, {}, 'GET')).status).toBe(405);
  enabled = false; expect((await request({})).status).toBe(403); enabled = true;
  expect((await request({}, { 'x-ashlr-token': 'read-only' })).status).toBe(401);
  expect((await request({}, { 'content-type': 'text/plain' })).status).toBe(415);
});
it('defaults to dry run and applies pause, resume and target through guarded writes', async () => {
  expect((await request(body('lane.pause', { lane: 'codex' }))).status).toBe(200);
  const slots = async () => JSON.parse(await readFile(join(root, 'queue', 'slots.json'), 'utf8')).codex;
  expect((await slots()).target).toBe(2);
  for (const [action, target] of [['lane.pause', 0], ['lane.resume', 2], ['lane.target', 3]] as const) {
    expect((await request(body(action, { lane: 'codex', dryRun: false, ...(action === 'lane.target' ? { target } : {}) }))).status).toBe(200);
    expect((await slots()).target).toBe(target);
  }
  expect((await request(body('lane.target', { lane: 'codex', target: 5 }))).status).toBe(503);
});
it('holds and unholds only unclaimed jobs and never mutates on dry run', async () => {
  const store = new QueueStore(join(root, 'queue'));
  expect((await request(body('queue.hold', { job: 'FIXUP-ashlr-md-431d697' }))).status).toBe(200);
  expect((await store.read()).jobs[0].status).toBe('READY');
  for (const action of ['queue.hold', 'queue.unhold']) expect((await request(body(action, { job: 'FIXUP-ashlr-md-431d697', dryRun: false }))).status).toBe(200);
  await store.claim('FIXUP-ashlr-md-431d697', 'fixture');
  expect((await request(body('queue.hold', { job: 'FIXUP-ashlr-md-431d697', dryRun: false }))).status).toBe(503);
});
it('retries one finished failed job, retaining original attempt', async () => {
  const store = new QueueStore(join(root, 'queue'));
  await store.claim('FIXUP-ashlr-md-431d697', 'fixture'); await store.finish('FIXUP-ashlr-md-431d697', 'fixture', { reason: 'failed' });
  expect((await request(body('job.retry', { job: 'FIXUP-ashlr-md-431d697' }))).status).toBe(200);
  expect((await store.read()).jobs).toHaveLength(1);
  expect((await request(body('job.retry', { job: 'FIXUP-ashlr-md-431d697', dryRun: false }))).status).toBe(200);
  expect((await store.read()).jobs).toHaveLength(2);
});
it('durably refuses concurrent nonce replay and emits only value-free audit rows', async () => {
  const input = body('queue.hold', { job: 'FIXUP-ashlr-md-431d697' });
  const results = await Promise.all([request(input), request(input)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  const text = await readFile(join(root, 'wb', 'audit.jsonl'), 'utf8');
  expect(text).not.toContain(input.nonce); expect(text).not.toContain('FIXUP-ashlr-md-431d697'); expect(text).not.toContain(token);
  for (const row of text.trim().split('\n').map(line => JSON.parse(line))) expect(Object.keys(row).sort()).toEqual(['action', 'at', 'outcome', 'v']);
});
it('never renders or logs secret-shaped input or unknown fields', async () => {
  const secret = 'sk-proj-' + 'x'.repeat(60);
  for (const input of [body(secret), body('lane.pause', { lane: secret }), body('job.retry', { job: secret }), body('reap.count', { secret }), { action: 'reap.count', nonce: secret }]) {
    const response = await request(input); expect(response.status).toBe(400); expect(await response.text()).not.toContain(secret);
  }
  expect(await readFile(join(root, 'wb', 'audit.jsonl'), 'utf8')).not.toContain(secret);
});
it('stores only the existing capability at 0600 and refuses unsafe files', async () => {
  const directory = join(root, 'wb');
  await storeWbToken(directory, token);
  expect((await stat(join(directory, 'token'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(directory, 'token'), 'utf8')).toBe(token);
  await chmod(join(directory, 'token'), 0o644);
  await expect(storeWbToken(directory, token)).rejects.toThrow();
  await rm(join(directory, 'token')); await symlink(join(root, 'queue', 'slots.json'), join(directory, 'token'));
  await expect(storeWbToken(directory, token)).rejects.toThrow();
});

it('counts reclaimable worktrees without returning paths or deleting them', async () => {
  const response = await request(body('reap.count'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ v: 1, dryRun: true, count: 2 });
});

it('fails closed on an unsafe audit sink before changing fleet state', async () => {
  await mkdir(join(root, 'wb'), { mode: 0o700 });
  const slots = join(root, 'queue', 'slots.json');
  const before = await readFile(slots, 'utf8');
  await symlink(slots, join(root, 'wb', 'audit.jsonl'));
  expect((await request(body('lane.pause', { lane: 'codex', dryRun: false }))).status).toBe(503);
  expect(await readFile(slots, 'utf8')).toBe(before);
});
it('refuses oversized bodies, malformed shapes, and dry runs above hard caps', async () => {
  expect((await request(body('reap.count', { padding: 'x'.repeat(4096) }))).status).toBe(400);
  for (const value of [null, [], body('lane.pause', { lane: 'codex', dryRun: 'false' }), body('lane.target', { lane: 'codex', target: 1.5 })]) expect((await request(value)).status).toBe(400);
  await writeFile(join(root, 'queue', 'slots.json'), JSON.stringify({ codex: { target: 2, floor: 0, ceiling: 4, hard_cap: 2 } }));
  expect((await request(body('lane.target', { lane: 'codex', target: 3 }))).status).toBe(503);
});

it('routes actions before the GET-only workbench catch-all', async () => {
  enabled = false;
  expect((await request({}, {}, 'POST', true)).status).toBe(403);
});
