import { describe, expect, it } from 'vitest';
import { deriveUpdateNotifications as derive } from './deriveUpdateNotifications.js';
import type { UpdateServerStatus } from '../../routes/verse/sections/update-status-queries.js';

const now = Date.parse('2026-10-31T12:15:00Z');
const sha = (c: string) => c.repeat(40);

const server = (over: Partial<UpdateServerStatus> & Record<string, unknown> = {}): UpdateServerStatus => ({
  v: 1, sourceState: 'healthy', installedVersion: '3.29.15',
  headSha: sha('a'), headAt: '2026-10-31T10:00:00Z', originSha: sha('b'), branch: 'master',
  behind: 0, ahead: 0, dirty: false, lastFetchAt: '2026-10-31T12:10:00Z',
  processStartedAt: '2026-10-31T08:00:00Z', uptimeSeconds: 15_300, canFastForward: false, ...over,
});

const lastApply = (over: Record<string, unknown> = {}) => ({
  outcome: 'updated', reason: null, startedAt: '2026-10-31T12:10:00Z',
  finishedAt: '2026-10-31T12:11:00Z', fromCommit: sha('a'), toCommit: sha('b'),
  restartRequired: true, restartMode: 'manual', ...over,
});

describe('successful server update notifications', () => {
  it('asks for a manual restart while the old commit is running', () => {
    expect(derive(server({ lastApply: lastApply() }), now)).toEqual([expect.objectContaining({
      id: 'update-restart-needed:bbbbbbb', category: 'action-required', severity: 'high',
      title: 'Phantom updated to bbbbbbb; restart to load it',
      detail: 'Quit and reopen Phantom to run the new code.',
      ts: '2026-10-31T12:11:00Z', actionLabel: 'Open Updates', actionRun: expect.any(Function),
    })]);
  });

  it('explains a supervised restart while the old commit is running', () => {
    expect(derive(server({ lastApply: lastApply({ restartMode: 'sidecar-supervised' }) }), now))
      .toEqual([expect.objectContaining({ id: 'update-restart-needed:bbbbbbb', severity: 'high',
        detail: 'Phantom restarts itself when idle.' })]);
  });

  it('reports the applied commit after the new code starts', () => {
    expect(derive(server({ headSha: sha('b'), lastApply: lastApply() }), now))
      .toEqual([expect.objectContaining({ id: 'update-applied:bbbbbbb', category: 'daemon-health', severity: 'info',
        title: 'Now running bbbbbbb', detail: 'Updated 4 min ago from aaaaaaa', ts: '2026-10-31T12:11:00Z' })]);
  });

  it('reports an apply without a restart and omits an unknown source commit', () => {
    expect(derive(server({ lastApply: lastApply({ restartRequired: false, fromCommit: null }) }), now))
      .toEqual([expect.objectContaining({ id: 'update-applied:bbbbbbb', detail: 'Updated 4 min ago' })]);
  });

  it('does not report a successful apply older than 24 hours', () => {
    expect(derive(server({ lastApply: lastApply({ finishedAt: '2026-10-30T11:15:00Z' }) }), now)).toEqual([]);
  });

  it('keeps the existing failure notification without reporting an apply', () => {
    const items = derive(server({ lastApply: lastApply({ outcome: 'failed', reason: 'update failed' }) }), now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'action-required', severity: 'critical',
      title: 'Update to bbbbbbb failed: update failed' });
    expect(items[0]?.id).toMatch(/^update-failed:bbbbbbb:[a-z0-9]+$/);
  });
});
