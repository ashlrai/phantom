import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { createFleetTeammateTasksApi } from '../src/core/verse/fleet-teammate-tasks-api.js';

const path = '/api/verse/fleet/control/teammate-tasks';
const call = async (url: string, api = handleFleetControlApi) => {
  send.mockClear();
  expect(await api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, path, 'GET')).toBe(true);
  return { status: send.mock.lastCall?.[1], body: send.mock.lastCall?.[2] };
};

it('selects an older persisted task before the cap and distinguishes absence and store failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'teamtasks-exact-'));
  const previous = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = root;
  const dir = join(root, 'imessage');
  const file = join(dir, 'teammate-tasks.json');
  try {
    mkdirSync(dir);
    const tasks = Array.from({ length: 60 }, (_, i) => ({
      jobId: `RQ-FAKE-${i}`, peer: 'dot', kind: 'report', scope: 'private fake scope', repo: 'example/repo',
      prRefs: [1], format: 'private fake format', deadline: '2030-01-01T00:00:00.000Z',
      token: i.toString(16).padStart(32, 'a'), createdAt: 1700000000000 + i, state: i === 0 ? 'replied' : 'queued',
      ...(i === 0 ? { attemptedAt: 1700000000001, receipt: { rowid: 1, sent: true, delivered: true, error: 0 },
        result: { rowid: 2, status: 'DONE', summary: 'private fake summary', at: 1700000000002 } } : {}),
      metrics: ['launch'], settled: false,
    }));
    const stored = JSON.stringify({ v: 1, attempts: { dot: [], instinct: [] }, tasks });
    writeFileSync(file, stored);
    const all = await call(path);
    expect(all.status).toBe(200);
    expect(all.body.rows).toHaveLength(50);
    expect(all.body.rows.some((row: { jobId: string }) => row.jobId === 'RQ-FAKE-0')).toBe(false);
    const selected = await call(`${path}?job=RQ-FAKE-0`);
    expect(selected.status).toBe(200);
    expect(selected.body.selection).toEqual({ jobId: 'RQ-FAKE-0' });
    expect(selected.body.matched).toBe(true);
    expect(selected.body.rows).toHaveLength(1);
    expect(selected.body.rows[0]).toMatchObject({ jobId: 'RQ-FAKE-0', workState: 'REPORTED_DONE' });
    expect(selected.body.counts).toEqual({ queued: 0, sending: 0, pending: 0, replied: 1, expired: 0, cancelled: 0 });
    expect(selected.body.truncated).toBe(false);
    for (const secret of ['token', 'claimKey', 'resource', 'receipt', 'result', 'summary', 'private fake', 'a'.repeat(32)]) {
      expect(JSON.stringify(selected.body)).not.toContain(secret);
    }
    const missing = await call(`${path}?job=RQ-FAKE-MISSING`);
    expect(missing.body).toMatchObject({ selection: { jobId: 'RQ-FAKE-MISSING' }, matched: false, rows: [], truncated: false });
    expect(Object.values(missing.body.counts).every(value => value === 0)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(stored);
    writeFileSync(file, '{invalid');
    expect(await call(`${path}?job=RQ-FAKE-0`)).toEqual({ status: 503, body: { error: 'teammate tasks unavailable' } });
  } finally {
    if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects malformed queries before reading and fails closed on unavailable readers', async () => {
  const read = vi.fn(() => { throw new Error('private diagnostic'); });
  const api = createFleetTeammateTasksApi(read);
  for (const query of ['?job=', '?job= ', '?job=a&job=b', '?other=a', '?job=a&other=b', '?job=a%2Fb', `?job=${'a'.repeat(81)}`, '?job=%']) {
    expect((await call(path + query, api)).status).toBe(400);
  }
  expect(read).not.toHaveBeenCalled();
  expect(await call(`${path}?job=RQ-FAKE-1`, api)).toEqual({ status: 503, body: { error: 'teammate tasks unavailable' } });
  const unavailable = createFleetTeammateTasksApi(() => ({ schema: 'fake', state: 'unavailable', tasks: [] }) as never);
  expect((await call(`${path}?job=RQ-FAKE-1`, unavailable)).status).toBe(503);
});
