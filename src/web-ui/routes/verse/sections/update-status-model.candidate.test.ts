import { describe, expect, it } from 'vitest';
import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import { describeUpdateStatus } from './update-status-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const facts = { v: 1, sourceState: 'healthy', installedVersion: '3.29.0', headSha: null, headAt: null, originSha: null, branch: 'master', behind: 12, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true } as UpdateServerStatus;
const base = { native: null, server: facts, appVersion: '3.29.0', desktopVersion: null, now: 0 };
const oldHeadline = '12 commits behind master · ready to fast-forward';
const withCandidate = (candidateVersion: unknown, patch: Partial<UpdateServerStatus> = {}): UpdateServerStatus =>
  ({ ...facts, ...patch, candidateVersion } as UpdateServerStatus);

describe('server update candidate', () => {
  it('names the newer version ready to fast-forward without changing other row properties', () => {
    const withoutCandidate = describeUpdateStatus(base);
    expect(describeUpdateStatus({ ...base, server: withCandidate('3.30.0') })).toEqual({
      ...withoutCandidate, headline: '3.30.0 ready · 12 commits behind master · fast-forward',
    });
  });

  it.each(['3.29.0', '3.28.9', 'invalid', null, 42])('keeps the headline for candidate %s', candidateVersion => {
    expect(describeUpdateStatus({ ...base, server: withCandidate(candidateVersion) }).headline).toBe(oldHeadline);
  });

  it('keeps the headline when the candidate is missing', () => {
    expect(describeUpdateStatus(base).headline).toBe(oldHeadline);
  });

  it.each([
    [{ dirty: true, canFastForward: false }, '3.30.0 available · 12 behind · local changes block the update'],
    [{ canFastForward: false }, '3.30.0 available · 12 behind · fast-forward unavailable'],
    [{ canFastForward: false, ahead: 2 }, '12 behind · 2 local commits ahead · diverged, update by hand'],
  ] as const)('describes a blocked checkout %j', (patch, headline) => {
    expect(describeUpdateStatus({ ...base, server: withCandidate('3.30.0', patch) }).headline).toBe(headline);
  });

  it('uses the native version for a staged update', () => {
    const native: DesktopUpdateState = { phase: 'staged', enabled: true, version: '3.29.1', bytesReceived: 0, bytesTotal: null, reason: null };
    expect(describeUpdateStatus({ ...base, native, server: withCandidate('3.30.0') }).headline).toBe('Update 3.29.1 ready · installs when idle');
  });
});
