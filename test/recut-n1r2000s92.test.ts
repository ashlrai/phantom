import { expect, it } from 'vitest';
import { deriveUpdateNotifications } from '../src/web-ui/components/notifications/deriveUpdateNotifications.js';
import type { UpdateServerStatus } from '../src/web-ui/routes/verse/sections/update-status-queries.js';

it('reports a completed self-update as an informational notification', () => {
  const status: UpdateServerStatus = {
    v: 1, sourceState: 'healthy', installedVersion: '3.29.4',
    headSha: 'a'.repeat(40), headAt: '2026-10-31T10:00:00Z', originSha: 'b'.repeat(40), branch: 'master',
    behind: 0, ahead: 0, dirty: false, lastFetchAt: '2026-10-31T12:10:00Z',
    processStartedAt: '2026-10-31T08:00:00Z', uptimeSeconds: 15300, canFastForward: false,
    lastApply: { outcome: 'updated', reason: null, startedAt: '2026-10-31T12:00:00Z',
      finishedAt: '2026-10-31T12:01:00Z', fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40),
      restartRequired: false, restartMode: 'manual' },
  };
  expect(deriveUpdateNotifications(status, Date.parse('2026-10-31T12:15:00Z'))).toEqual([
    expect.objectContaining({ id: 'update-applied:bbbbbbb', category: 'daemon-health', severity: 'info', title: 'Now running bbbbbbb' }),
  ]);
});
