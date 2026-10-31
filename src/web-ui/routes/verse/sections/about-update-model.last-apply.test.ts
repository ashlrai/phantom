import { describe, expect, it } from 'vitest';
import { aboutUpdateLines, lastApplyOf } from './about-update-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const last = { outcome: 'updated', reason: null, startedAt: '2026-10-31T09:59:00Z', finishedAt: '2026-10-31T10:00:00Z',
  fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40), restartRequired: true, restartMode: 'manual' };
const status: UpdateServerStatus = {
  v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: last.toCommit,
  headAt: null, originSha: null, branch: 'master', behind: 0, ahead: 0, dirty: false,
  lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: false,
};
function row(over = {}, headSha: string | null = last.toCommit) {
  const observation = { ...status, headSha, lastApply: { ...last, ...over } };
  return aboutUpdateLines(observation, now).rows.find((r) => r.label === 'Last update');
}

describe('About last update', () => {
  it('shows the outcome, completion time and short destination', () => {
    expect(row()?.value).toBe('updated 2 hours ago · to bbbbbbb');
  });
  it.each(['failed', 'refused'])('shows the reason for %s', (outcome) => {
    expect(row({ outcome, reason: 'dirty working tree', restartRequired: false })?.value)
      .toBe(`${outcome} 2 hours ago · dirty working tree`);
  });
  it('shows pending restart only while running the previous commit', () => {
    expect(row({}, last.fromCommit)?.value).toBe('updated 2 hours ago · to bbbbbbb · restart needed');
    expect(row()?.value).not.toContain('restart needed');
    expect(row({ restartRequired: false }, last.fromCommit)?.value).not.toContain('restart needed');
    expect(row({ fromCommit: null }, null)?.value).not.toContain('restart needed');
  });
  it('omits absent or malformed history', () => {
    expect(aboutUpdateLines(status, now).rows.some((r) => r.label === 'Last update')).toBe(false);
    for (const lastApply of [null, {}, { ...last, finishedAt: 'bad' }, { ...last, restartRequired: 'yes' }]) {
      expect(lastApplyOf({ lastApply })).toBeNull();
    }
  });
});
