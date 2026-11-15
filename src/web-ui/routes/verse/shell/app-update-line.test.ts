import { describe, expect, it } from 'vitest';
import { appUpdateLine, readAppUpdateResponse, type AppUpdateStatusResponse } from './app-update-line.js';

const status = (over: Partial<AppUpdateStatusResponse> = {}): AppUpdateStatusResponse => ({
  v: 1, available: null, deferredReason: null, runningJobCount: null, unknownJobs: null, ...over,
});

describe('readAppUpdateResponse', () => {
  it('accepts the v:1 wire shape and tolerates extra fields', () => {
    const wire = { ...status({ available: '3.30.2' }), generatedAt: 'now' };
    expect(readAppUpdateResponse(wire)).toMatchObject(status({ available: '3.30.2' }));
  });

  it.each([
    ['not a record', null],
    ['a different version', { ...status(), v: 2 }],
    ['a non-string version', { ...status(), available: 3 as unknown as string }],
    ['a missing reason', { v: 1, available: '3.30.2', runningJobCount: null, unknownJobs: null }],
    ['a negative count', { ...status(), runningJobCount: -1 }],
    ['a fractional count', { ...status(), unknownJobs: 0.5 }],
  ])('returns null for %s', (_name, raw) => {
    expect(readAppUpdateResponse(raw)).toBeNull();
  });
});

describe('appUpdateLine', () => {
  it('says nothing when no candidate is staged', () => {
    expect(appUpdateLine(status())).toBeNull();
    expect(appUpdateLine(status({ deferredReason: 'native-status-unavailable' }))).toBeNull();
  });

  it('names the running jobs holding the update', () => {
    expect(appUpdateLine(status({ available: '3.30.2', deferredReason: 'work-active-or-unknown', runningJobCount: 3, unknownJobs: 0 })))
      .toBe('Update 3.30.2 staged · waiting for 3 running jobs');
    expect(appUpdateLine(status({ available: '3.30.2', deferredReason: 'work-active-or-unknown', runningJobCount: 1, unknownJobs: 0 })))
      .toBe('Update 3.30.2 staged · waiting for 1 running job');
    expect(appUpdateLine(status({ available: '3.30.2', deferredReason: 'work-active-or-unknown', runningJobCount: 2, unknownJobs: 1 })))
      .toBe('Update 3.30.2 staged · waiting for 3 running jobs');
    expect(appUpdateLine(status({ available: '3.30.2', deferredReason: 'work-active-or-unknown' })))
      .toBe('Update 3.30.2 staged · waiting for running jobs');
  });

  it('says a clear candidate applies on restart', () => {
    expect(appUpdateLine(status({ available: '3.30.2', runningJobCount: 0, unknownJobs: 0 })))
      .toBe('Update 3.30.2 staged · applies on next restart');
  });

  it('shows an unmapped hold as "held: <reason>"', () => {
    expect(appUpdateLine(status({ available: '3.30.2', deferredReason: 'stop-required' })))
      .toBe('Update 3.30.2 staged · held: stop-required');
    expect(appUpdateLine(status({ available: '3.30.2', deferredReason: 'authority-reapproval-required' })))
      .toBe('Update 3.30.2 staged · held: authority-reapproval-required');
  });
});
