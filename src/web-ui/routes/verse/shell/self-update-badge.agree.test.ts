import { describe, expect, it } from 'vitest';
import { updateEntryLabel, type SelfUpdateStatus } from './self-update-badge.js';

const status: SelfUpdateStatus = {
  v: 1, generatedAt: 'now', sourceState: 'healthy', installedVersion: null, repoRoot: true,
  headSha: null, headAt: null, originSha: null, branch: null, behind: 2, ahead: 0,
  dirty: false, lastFetchAt: null, processStartedAt: 'now', uptimeSeconds: 1, pid: 42,
  canFastForward: true,
};

describe('update badge and Update now agreement', () => {
  it.each([
    [{}, 'Update available · 2 commits behind'],
    [{ canFastForward: false, dirty: true, ahead: 1 }, 'Update blocked · local changes'],
    [{ canFastForward: false, ahead: 1 }, 'Update blocked · diverged'],
    [{ canFastForward: false }, 'Update blocked · open Settings'],
    [{ canFastForward: null }, 'Update blocked · open Settings'],
    [{ canFastForward: true, dirty: true }, 'Update blocked · local changes'],
    [{ canFastForward: true, dirty: null }, 'Update available · 2 commits behind'],
    [{ behind: 1 }, 'Update available · 1 commit behind'],
    [{ sourceState: 'unavailable', canFastForward: false }, null],
    [{ behind: 0 }, null],
    [{ behind: null }, null],
  ] satisfies Array<[Partial<SelfUpdateStatus>, string | null]>)('labels %j', (changes, expected) => {
    const fixture = { ...status, ...changes };
    const enabled = fixture.canFastForward === true && fixture.behind !== null
      && fixture.behind > 0 && fixture.dirty !== true;
    const label = updateEntryLabel(fixture);
    expect(label).toBe(expected);
    expect(label?.startsWith('Update available') ?? false).toBe(enabled);
  });
});
