import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/fleet/apps';
const id = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789abd';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'history-api-')); dirs.push(dir);
  const locate = vi.fn(() => '/fake/script');
  const exec = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, running: true }), stderr: '' }));
  return { dir, locate, exec, api: createFleetAppsApi({ runsDir: dir, locateScript: locate, exec }) };
}
async function call(api: ReturnType<typeof createFleetAppsApi>, url: string, method = 'GET') {
  const req = Object.assign(new PassThrough(), { url, headers: {}, socket: {} }) as unknown as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const handled = await api({ allowDispatch: true } as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { handled, status, body: JSON.parse(text), text };
}
const observation = { kind: 'apps-watch.observation.v1', invocationId: id, cycle: 1, healthy: false, recoveries: 0, consecutiveFailures: 1, totalFailedCycles: 1, observedState: [{ app: 'Phantom', observedRunning: null }] };
const summary = { kind: 'apps-watch.summary.v1', invocationId: id, apps: ['Phantom'], outcome: 'failed', cycles: 1, recoveries: 0, consecutiveFailures: 1, totalFailedCycles: 1, lastObservedState: null };
function append(dir: string, n: number, body: unknown, from = 'apps-watch') {
  expect(appendBusInbox({ id: `test-${n}`, from, to: 'leaders', priority: 'P2', ttl: 86400000, body }, { root: dir }).status).toBe('posted');
}

it('projects retained events, filters invocations, and resumes without app control', async () => {
  const { api, dir, exec, locate } = setup();
  append(dir, 1, { secret: 'private-body' }, 'other');
  append(dir, 2, { ...observation, privatePath: '/private/path' });
  append(dir, 3, { ...summary, invocationId: other });
  append(dir, 4, summary);
  const first = await call(api, `${path}/history?limit=1&invocationId=${id}`);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ v: 1, availability: 'available', nextCursor: 2, hasMore: true, events: [{ cursor: 2, kind: observation.kind }] });
  expect(first.text).not.toContain('private');
  const next = await call(api, `${path}/history?after=${first.body.nextCursor}&invocationId=${id}`);
  expect(next.body).toMatchObject({ nextCursor: 4, hasMore: false, events: [{ cursor: 4, kind: summary.kind, outcome: 'failed' }] });
  const all = await call(api, `${path}/history`);
  expect(all.body.events).toHaveLength(3);
  expect(all.text).not.toContain('private');
  expect(exec).not.toHaveBeenCalled(); expect(locate).not.toHaveBeenCalled();
  expect((await call(api, `${path}?app=Phantom`)).status).toBe(200);
  expect(exec).toHaveBeenCalledTimes(1); expect(locate).toHaveBeenCalledTimes(1);
});

it('rejects malformed queries and methods before app control, and distinguishes reader failures', async () => {
  const { api, dir, exec, locate } = setup();
  for (const query of ['?x=1', '?after=0&after=1', '?limit=1&limit=2', '?invocationId=a&invocationId=b', '?after=-1', '?after=1.0', '?after=9007199254740992', '?limit=0', '?limit=101', '?limit=+1', '?invocationId=bad', '?invocationId=']) {
    expect((await call(api, `${path}/history${query}`)).status, query).toBe(400);
  }
  expect((await call(api, `${path}/history`, 'POST')).status).toBe(405);
  const invalid = await call(api, `${path}/history?after=1`);
  expect(invalid.status).toBe(400); expect(invalid.body.availability).toBe('invalid-cursor');
  chmodSync(dir, 0o755);
  const unavailable = await call(api, `${path}/history`);
  expect(unavailable.status).toBe(503); expect(unavailable.body).toEqual({ error: 'fleet apps history unavailable' });
  chmodSync(dir, 0o700);
  expect(exec).not.toHaveBeenCalled(); expect(locate).not.toHaveBeenCalled();
});
