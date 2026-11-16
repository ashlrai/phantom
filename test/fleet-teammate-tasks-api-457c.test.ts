import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetTeammateTasksApi, projectTeammateTasks } from '../src/core/verse/fleet-teammate-tasks-api.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { narrowTeammateTasks } from '../src/web-ui/routes/verse/fleet-channels/teammate-tasks-model.js';

const PATH = '/api/verse/fleet/control/teammate-tasks';
type Raw = Parameters<typeof projectTeammateTasks>[0];
const task = (i: number, state: string, status?: 'DONE' | 'BLOCKED' | 'FAILED') => ({
  jobId: `RQ-FAKE-${i}`, peer: 'dot', kind: 'report', repo: 'example/repo', prRefs: [i + 1],
  deadline: '2030-01-01T00:00:00.000Z', createdAt: 1_700_000_000_000 + i, state,
  token: '0'.repeat(32), receipt: { rowid: 1, sent: true, delivered: true, error: 0 },
  claimKey: `queue:imsg.dot.RQ-FAKE-${i}`, resource: 'imsg:dot', attempts: [1], metrics: ['launch'],
  result: status ? { rowid: 2, status, at: 1, evidence: 'peer-reported', summary: 'secret summary' } : null,
}) as unknown as Raw['tasks'][number];
const raw = (tasks: Raw['tasks']): Raw => ({ schema: 'imessage.teammate-tasks.v1', state: 'healthy', tasks }) as Raw;
const NOW = '2026-11-15T00:00:00.000Z';

it('maps every state to an honest workState', () => {
  const t = [task(1, 'queued'), task(2, 'sending'), task(3, 'pending'), task(4, 'replied', 'DONE'),
    task(5, 'replied', 'FAILED'), task(6, 'replied', 'BLOCKED'), task(7, 'expired'), task(8, 'cancelled')];
  const p = projectTeammateTasks(raw(t), NOW);
  const by = Object.fromEntries(p.rows.map(r => [r.jobId, r.workState]));
  expect(by).toEqual({ 'RQ-FAKE-1': 'ASSIGNED', 'RQ-FAKE-2': 'ASSIGNED', 'RQ-FAKE-3': 'RUNNING', 'RQ-FAKE-4': 'REPORTED_DONE',
    'RQ-FAKE-5': 'BLOCKED', 'RQ-FAKE-6': 'BLOCKED', 'RQ-FAKE-7': 'UNKNOWN', 'RQ-FAKE-8': 'CANCELLED' });
  expect(p.counts).toEqual({ queued: 1, sending: 1, pending: 1, replied: 3, expired: 1, cancelled: 1 });
});

it('caps rows at 50 newest first while counts cover every task', () => {
  const p = projectTeammateTasks(raw(Array.from({ length: 60 }, (_, i) => task(i, i % 2 ? 'queued' : 'pending'))), NOW);
  expect(p.rows).toHaveLength(50); expect(p.truncated).toBe(true);
  expect(p.rows[0]!.jobId).toBe('RQ-FAKE-59'); expect(p.rows[49]!.jobId).toBe('RQ-FAKE-10');
  expect(p.counts.queued + p.counts.pending).toBe(60);
  expect(projectTeammateTasks(raw([task(1, 'queued')]), NOW).truncated).toBe(false);
});

it('emits no forbidden keys or tokens', () => {
  const s = JSON.stringify(projectTeammateTasks(raw([task(1, 'replied', 'DONE'), task(2, 'pending')]), NOW));
  for (const k of ['token', 'receipt', 'claimKey', 'resource', 'attempts', 'metrics', 'scope', 'format', 'summary', 'result']) expect(s).not.toContain(`"${k}"`);
  expect(s).not.toMatch(/[a-f0-9]{32}/); expect(s).not.toContain('secret summary');
});

const call = (api: ReturnType<typeof createFleetTeammateTasksApi>, url: string, method: string) =>
  api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);

it('handler: 200, 405, 400, 503, other path; body agrees with the card model', async () => {
  const read = vi.fn(() => raw([task(1, 'pending'), task(2, 'replied', 'DONE')]));
  const api = createFleetTeammateTasksApi(read, () => new Date(NOW));
  expect(await call(api, '/other', 'GET')).toBe(false);
  expect(await call(api, PATH, 'POST')).toBe(true); expect(send.mock.lastCall?.[1]).toBe(405);
  await call(api, `${PATH}?x=1`, 'GET'); expect(send.mock.lastCall?.[1]).toBe(400);
  expect(read).not.toHaveBeenCalled();
  await call(api, PATH, 'GET');
  expect(send.mock.lastCall?.[1]).toBe(200);
  const view = narrowTeammateTasks(send.mock.lastCall?.[2]);
  expect(view?.complete).toBe(true); expect(view?.rows).toHaveLength(2); expect(view?.asOf).toBe(NOW);
  read.mockImplementationOnce(() => { throw new Error('private diagnostic'); });
  await call(createFleetTeammateTasksApi(read), PATH, 'GET');
  expect(send.mock.lastCall?.slice(1)).toEqual([503, { error: 'teammate tasks unavailable' }]);
});

it('is reachable through the real fleet-control dispatcher', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teamtasks-'));
  const old = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  process.env.HOME = home; process.env.ASHLR_HOME = join(home, '.ashlr');
  try {
    send.mockClear();
    const url = PATH;
    const handled = await handleFleetControlApi({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, PATH, 'GET');
    expect(handled).not.toBe(false);
    expect([200, 503]).toContain(send.mock.lastCall?.[1]);
  } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
