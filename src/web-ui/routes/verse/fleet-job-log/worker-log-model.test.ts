import { describe, expect, it, vi } from 'vitest';
import * as client from '../../../data/client.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { isJobDetail, JOB_ID_RE, jobOptions, metaLine, pollMs } from './worker-log-model.js';
import { jobDetailQuery } from './worker-log-queries.js';

describe('worker log model', () => {
  it('validates IDs before requesting them', async () => {
    for (const id of ['RQ-X', 'abc', 'a._-9', 'x'.repeat(80)]) expect(JOB_ID_RE.test(id)).toBe(true);
    for (const id of ['', 'ab', '.abc', 'a/b', 'abc ', 'x'.repeat(81)]) expect(JOB_ID_RE.test(id)).toBe(false);
    const spy = vi.spyOn(client, 'apiGet');
    await expect(jobDetailQuery('../oops').fetch()).rejects.toThrow('Invalid job ID');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('sorts running workers oldest first and formats their labels', () => {
    const runs = { workers: [
      { job: 'RQ-NEW', lane: 'codex-personal', ageSeconds: 60 },
      { job: 'RQ-OLD', lane: 'codex-personal', ageSeconds: 720 },
      { job: 'RQ-UNKNOWN', lane: 'codex', ageSeconds: null },
    ] } as FleetRuns;
    expect(jobOptions(runs)).toEqual([
      { job: 'RQ-OLD', label: 'RQ-OLD · codex-personal · 12 min' },
      { job: 'RQ-NEW', label: 'RQ-NEW · codex-personal · 1 min' },
      { job: 'RQ-UNKNOWN', label: 'RQ-UNKNOWN · codex · age unknown' },
    ]);
  });
  it('guards optional fields and rejects malformed values', () => {
    expect(isJobDetail({ schema: 'fleet.job.v1' })).toBe(true);
    expect(isJobDetail({ schema: 'fleet.job.v1', log: { tail: ['ok', 4] } })).toBe(false);
    expect(isJobDetail({ schema: 'other' })).toBe(false);
  });
  it('formats metadata, null fields and polling intervals', () => {
    const detail = { schema: 'fleet.job.v1' as const, state: 'running' as const, lane: 'codex-personal', tier: 'mid', model: 'gpt-6.1-terra', launchedAt: '2026-10-31T11:48:00Z', publish: { prUrl: 'https://github.com/example/repo/pull/1234' } };
    expect(metaLine(detail, Date.parse('2026-10-31T12:00:00Z'))).toBe('running · codex-personal mid · gpt-6.1-terra · launched 12 min ago · PR #1234');
    expect(metaLine({ schema: 'fleet.job.v1', state: null, publish: null }, 0)).toBe('unknown');
    expect(pollMs(detail)).toBe(4000);
    expect(pollMs({ schema: 'fleet.job.v1', state: 'archived' })).toBe(15000);
    expect(pollMs(null)).toBe(15000);
  });
  it('maps only a 404 to a missing API', async () => {
    const spy = vi.spyOn(client, 'apiGet').mockRejectedValueOnce(new client.ApiError('missing', 404, '/api/fleet/job'))
      .mockRejectedValueOnce(new client.ApiError('bad', 500, '/api/fleet/job'));
    await expect(jobDetailQuery('RQ-ONE').fetch()).resolves.toBeNull();
    await expect(jobDetailQuery('RQ-ONE').fetch()).rejects.toMatchObject({ status: 500 });
    spy.mockRestore();
  });
});
