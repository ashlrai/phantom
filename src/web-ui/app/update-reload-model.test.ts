import { describe, expect, it } from 'vitest';
import { decideReload, type UpdateReloadReading } from './update-reload-model.js';

const reading = (over: Partial<UpdateReloadReading> = {}): UpdateReloadReading => ({
  installedVersion: '3.30.0',
  headSha: 'abc1234',
  sourceState: 'healthy',
  ...over,
});

describe('decideReload', () => {
  it('flags interface-behind when the server build differs from the page build', () => {
    const decision = decideReload({
      first: reading(), current: reading({ installedVersion: '3.30.1' }),
      appVersion: '3.30.0', dismissedSha: null,
    });
    expect(decision).toEqual({
      show: true, reason: 'interface-behind', sha: 'abc1234',
      message: 'Phantom updated to 3.30.1 — reload to use the new interface',
    });
  });

  it('interface-behind wins over server-restarted and survives a null headSha', () => {
    const both = decideReload({
      first: reading(), current: reading({ installedVersion: '3.30.1', headSha: 'def5678' }),
      appVersion: '3.30.0', dismissedSha: null,
    });
    expect(both).toMatchObject({ show: true, reason: 'interface-behind', sha: 'def5678' });
    const noSha = decideReload({
      first: reading(), current: reading({ installedVersion: '3.30.1', headSha: null }),
      appVersion: '3.30.0', dismissedSha: null,
    });
    expect(noSha).toMatchObject({ show: true, reason: 'interface-behind', sha: null });
  });

  it('flags server-restarted when the commit changed since page load', () => {
    const decision = decideReload({
      first: reading({ headSha: 'abc1234' }), current: reading({ headSha: 'def5678' }),
      appVersion: '3.30.0', dismissedSha: null,
    });
    expect(decision).toEqual({
      show: true, reason: 'server-restarted', sha: 'def5678',
      message: 'Phantom restarted on new code — reload',
    });
  });

  it('shows nothing for matching versions and the same commit', () => {
    expect(decideReload({
      first: reading(), current: reading(), appVersion: '3.30.0', dismissedSha: null,
    })).toEqual({ show: false });
  });

  it('a dismissed sha stays quiet, and a further change asks again', () => {
    const input = {
      first: reading(), current: reading({ headSha: 'def5678' }),
      appVersion: '3.30.0', dismissedSha: 'def5678',
    };
    expect(decideReload(input)).toEqual({ show: false });
    expect(decideReload({ ...input, current: reading({ headSha: 'aaa9999' }) }))
      .toMatchObject({ show: true, reason: 'server-restarted' });
  });

  it('shows nothing for unavailable or missing readings', () => {
    const unavailable = reading({ sourceState: 'unavailable', installedVersion: '3.30.1', headSha: 'def5678' });
    expect(decideReload({ first: null, current: unavailable, appVersion: '3.30.0', dismissedSha: null }))
      .toEqual({ show: false });
    expect(decideReload({ first: null, current: null, appVersion: '3.30.0', dismissedSha: null }))
      .toEqual({ show: false });
  });

  it('needs real strings on both sides of the restart comparison', () => {
    expect(decideReload({
      first: reading({ headSha: null }), current: reading({ headSha: 'def5678' }),
      appVersion: '3.30.0', dismissedSha: null,
    })).toEqual({ show: false });
    expect(decideReload({
      first: reading(), current: reading({ installedVersion: null, headSha: null }),
      appVersion: '3.30.0', dismissedSha: null,
    })).toEqual({ show: false });
  });
});
