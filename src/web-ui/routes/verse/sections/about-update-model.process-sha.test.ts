import { describe, expect, it } from 'vitest';
import { aboutUpdateLines } from './about-update-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const fromCommit = 'a'.repeat(40);
const toCommit = 'b'.repeat(40);
const status: UpdateServerStatus = {
  v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: toCommit,
  headAt: null, originSha: null, branch: 'master', behind: 0, ahead: 0, dirty: false,
  lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: false,
};
const lastApply = {
  outcome: 'updated', reason: null, startedAt: '2026-10-31T09:59:00Z', finishedAt: '2026-10-31T10:00:00Z',
  fromCommit, toCommit, restartRequired: true, restartMode: 'manual',
};
const now = Date.parse('2026-10-31T12:00:00Z');

function row(observation: UpdateServerStatus & { lastApply?: unknown; processHeadSha?: unknown }) {
  return aboutUpdateLines(observation, now).rows.find((r) => r.label === 'Last update')?.value;
}

describe('About last update process commit', () => {
  it('shows a pending restart when the process still runs the old commit', () => {
    expect(row({ ...status, lastApply, processHeadSha: fromCommit })).toBe('updated 2 hours ago · to bbbbbbb · restart needed');
  });

  it('clears the pending restart when the process runs the new commit', () => {
    expect(row({ ...status, lastApply, processHeadSha: toCommit })).toBe('updated 2 hours ago · to bbbbbbb');
  });

  it('falls back to the disk commit when the process commit is missing or invalid', () => {
    expect(row({ ...status, lastApply })).toBe('updated 2 hours ago · to bbbbbbb');
    expect(row({ ...status, lastApply, headSha: fromCommit })).toBe('updated 2 hours ago · to bbbbbbb · restart needed');
    const invalid = { ...status, lastApply, headSha: fromCommit, processHeadSha: 42 };
    expect(row(invalid)).toBe('updated 2 hours ago · to bbbbbbb · restart needed');
  });
});
