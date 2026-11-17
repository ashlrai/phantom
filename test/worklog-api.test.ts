import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { handleApi } from '../src/core/web/api.js';
import { readWorklog, worklog } from '../src/core/fleet/worklog.js';
vi.mock('../src/core/fleet/worklog.js', async importOriginal => ({ ...await importOriginal<object>(), readWorklog: vi.fn() }));
const cfg = { roots: [], tools: {} } as unknown as AshlrConfig;
async function request(query = '') {
  const result = { status: 0, body: '' };
  const req = { method: 'GET', url: `/api/worklog${query}`, headers: {} } as IncomingMessage;
  const res = { writeHead: (status: number) => { result.status = status; }, end: (body: string) => { result.body = body; } } as unknown as ServerResponse;
  expect(await handleApi(req, res, cfg, { token: 'unused', allowDispatch: false })).toBe(true);
  return { status: result.status, body: JSON.parse(result.body) };
}
beforeEach(() => { vi.mocked(readWorklog).mockReset(); });
describe('work log API', () => {
  it('applies lane, repo and since filters through the shared projection', async () => {
    const rows = [{ event: 'launch', job: 'A', lane: 'work', repo: 'phantom', ts: '2026-11-09T10:00:00Z' },
      { event: 'launch', job: 'B', lane: 'fast', repo: 'locus', ts: '2026-11-09T10:00:00Z' }];
    vi.mocked(readWorklog).mockResolvedValue(worklog(rows.map(row => JSON.stringify(row)).join('\n'), 0, Date.parse('2026-11-10')));
    const response = await request('?since=1h&lane=work&repo=phantom');
    expect(response.status).toBe(200); expect(response.body.entries.map((e: { job: string }) => e.job)).toEqual(['A']);
    expect(readWorklog).toHaveBeenCalledWith(1);
  });
  it('rejects an invalid time window before reading', async () => {
    expect((await request('?since=bad')).status).toBe(400); expect(readWorklog).not.toHaveBeenCalled();
  });
  it('keeps an empty ledger distinct from a failed read', async () => {
    vi.mocked(readWorklog).mockResolvedValue(worklog('', 0, 0));
    expect((await request()).body.entries).toEqual([]);
    vi.mocked(readWorklog).mockRejectedValue(new Error('private detail'));
    expect(await request()).toEqual({ status: 503, body: { error: 'Jobs ledger is unreadable.' } });
  });
});
