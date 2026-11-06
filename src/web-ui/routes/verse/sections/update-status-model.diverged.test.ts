import { describe, expect, it, vi } from 'vitest';
import { apiGet } from '../../../data/client.js';
import { describeUpdateStatus } from './update-status-model.js';
import { updateStatusQuery, type UpdateServerStatus } from './update-status-queries.js';

vi.mock('../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(),
}));

const facts: UpdateServerStatus = {
  v: 1, sourceState: 'healthy', installedVersion: '3.30.0', headSha: 'abcdef123456', headAt: null,
  originSha: null, branch: 'release/3.30', behind: 3, ahead: 2, dirty: false,
  lastFetchAt: null, processStartedAt: null, uptimeSeconds: 30, canFastForward: false,
};
const lastApply = {
  outcome: 'refused' as const, reason: 'dirty tree', startedAt: '2026-10-31T12:00:00Z',
  finishedAt: '2026-10-31T12:01:00Z', fromCommit: 'abcdef123456', toCommit: null,
  restartRequired: false, restartMode: 'manual' as const,
};
const base = { native: null, server: facts, appVersion: '3.30.0', desktopVersion: null, now: Date.parse('2026-10-31T12:06:00Z') };

describe('server update explanations', () => {
  it('explains divergence and gives local changes priority', () => {
    expect(describeUpdateStatus(base)).toMatchObject({ headline: '3 behind · 2 local commits ahead · diverged, update by hand', tone: 'warning' });
    expect(describeUpdateStatus({ ...base, server: { ...facts, ahead: 1 } }).headline).toBe('3 behind · 1 local commit ahead · diverged, update by hand');
    expect(describeUpdateStatus({ ...base, server: { ...facts, dirty: true } }).headline).toBe('3 behind · local changes block the update');
    expect(describeUpdateStatus({ ...base, server: { ...facts, ahead: 0 } }).headline).toBe('3 behind · fast-forward unavailable');
    expect(describeUpdateStatus({ ...base, server: { ...facts, canFastForward: null } }).headline).toBe('3 behind · fast-forward unavailable');
  });

  it('uses the server branch for ready and current status, with a null fallback', () => {
    expect(describeUpdateStatus({ ...base, server: { ...facts, canFastForward: true } }).headline).toBe('3 commits behind release/3.30 · ready to fast-forward');
    expect(describeUpdateStatus({ ...base, server: { ...facts, behind: 0 } }).headline).toBe('Up to date with release/3.30');
    expect(describeUpdateStatus({ ...base, server: { ...facts, branch: null, behind: 0 } }).headline).toBe('Up to date with master');
  });

  it('appends refused, failed and successful attempts without losing existing details', () => {
    expect(describeUpdateStatus({ ...base, server: { ...facts, lastApply } }).detail).toBe('Phantom 3.30.0 · abcdef1 · up 30s · fetched never · last update refused 5m ago · dirty tree');
    expect(describeUpdateStatus({ ...base, server: { ...facts, lastApply: { ...lastApply, outcome: 'failed', reason: 'fetch failed' } } }).detail).toContain('last update failed 5m ago · fetch failed');
    expect(describeUpdateStatus({ ...base, server: { ...facts, lastApply: { ...lastApply, outcome: 'updated', toCommit: '123456789abc' } } }).detail).toContain('updated to 1234567 5m ago');
    expect(describeUpdateStatus({ ...base, server: { ...facts, lastApply: { ...lastApply, outcome: 'already-current' } } }).detail).not.toContain('last update');
  });

  it('accepts optional last apply data and retains branch and ahead in the query', async () => {
    const payload = { ...facts, lastApply: { ...lastApply, extra: 'ignored' } };
    vi.mocked(apiGet).mockResolvedValue(payload);
    expect(await updateStatusQuery.fetch()).toEqual(payload);
    vi.mocked(apiGet).mockResolvedValue({ ...facts, lastApply: null });
    expect(await updateStatusQuery.fetch()).toEqual({ ...facts, lastApply: null });
    vi.mocked(apiGet).mockResolvedValue(facts);
    expect(await updateStatusQuery.fetch()).toEqual(facts);
    vi.mocked(apiGet).mockResolvedValue({ ...facts, lastApply: { ...lastApply, finishedAt: 'invalid' } });
    await expect(updateStatusQuery.fetch()).rejects.toThrow('Invalid update status');
  });
});
