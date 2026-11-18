import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { handleApi } from '../src/core/web/api.js';
import { readWorklog, worklog } from '../src/core/fleet/worklog.js';
vi.mock('../src/core/fleet/worklog.js', async importOriginal => ({ ...await importOriginal<object>(), readWorklog: vi.fn() }));
const cfg = { roots: [], tools: {} } as unknown as AshlrConfig;
async function request(query = '') {
  const result = { status: 0, body: '' };
  const req = { method: 'GET', url: `/api/log${query}`, headers: {} } as IncomingMessage;
  const res = { writeHead: (status: number) => { result.status = status; }, end: (body: string) => { result.body = body; } } as unknown as ServerResponse;
  expect(await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false })).toBe(true);
  return { status: result.status, body: JSON.parse(result.body) };
}
const rows = [{ event: 'launch', job: 'A', lane: 'work', repo: 'phantom', model: 'model-a', ts: '2026-11-09T10:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'A', url: 'https://github.com/ashlrai/phantom/pull/7', ttm_s: 60, ts: '2026-11-09T10:30:00Z' },
  { event: 'launch', job: 'B', lane: 'fast', repo: 'locus', ts: '2026-11-09T10:40:00Z' }];
beforeEach(() => {
  vi.mocked(readWorklog).mockReset();
  vi.mocked(readWorklog).mockImplementation(async hours => worklog(rows.map(row => JSON.stringify(row)).join('\n'), 0, Date.parse('2026-11-10'), { hours }));
});
describe('job log API', () => {
  it('serves one row per job with the summary, read through the work log reader', async () => {
    const response = await request();
    expect(response.status).toBe(200); expect(readWorklog).toHaveBeenCalledWith(6);
    expect(response.body).toMatchObject({ schema: 'joblog.v1', version: 1, hours: 6, headline: '2 jobs, 1 merged, 0% made no change, median time to merge 1m 0s.' });
    expect(response.body.jobs.map((job: { job: string; text: string }) => [job.job, job.text])).toEqual([['B', 'Still running, no result yet'], ['A', 'Merged PR 7']]);
  });
  it('applies since, lane and repo filters and recounts the summary', async () => {
    const response = await request('?since=2h&lane=work&repo=phantom');
    expect(readWorklog).toHaveBeenCalledWith(2);
    expect(response.body.jobs).toEqual([{ job: 'A', at: '2026-11-09T10:30:00.000Z', lane: 'work', model: 'model-a', repo: 'phantom', goal: null, result: 'merged',
      text: 'Merged PR 7', pr: 7, url: 'https://github.com/ashlrai/phantom/pull/7', mergeSeconds: 60 }]);
    expect(response.body.summary).toMatchObject({ jobs: 1, merged: 1, lanes: [{ lane: 'work', jobs: 1 }] });
    expect((await request('?lane=none')).body.jobs).toEqual([]);
  });
  it('rejects a bad time window before reading and hides read errors', async () => {
    expect((await request('?since=bad')).status).toBe(400); expect((await request('?hours=0')).status).toBe(400);
    expect(readWorklog).not.toHaveBeenCalled();
    vi.mocked(readWorklog).mockRejectedValue(new Error('private detail'));
    expect(await request()).toEqual({ status: 503, body: { error: 'Jobs ledger is unreadable.' } });
  });
});
