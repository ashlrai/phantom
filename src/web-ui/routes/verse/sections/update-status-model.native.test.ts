import { describe, expect, it } from 'vitest';
import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import { describeUpdateStatus } from './update-status-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const packagedFacts: UpdateServerStatus = { v: 1, sourceState: 'unavailable', installedVersion: '3.30.0', headSha: null, headAt: null, originSha: null, branch: null, behind: null, ahead: null, dirty: null, lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: false };
const native: DesktopUpdateState = { phase: 'idle', enabled: true, version: '3.30.0', bytesReceived: 0, bytesTotal: null, reason: null };
const base = { native: null, server: packagedFacts, appVersion: '3.30.0', desktopVersion: '3.30.0', now: 0 };

describe('describeUpdateStatus with a native updater on a packaged build', () => {
  it.each([
    ['current', 'Up to date', 'success'],
    ['checking', 'Checking for updates…', 'info'],
    ['idle', 'Automatic updates on · checks when idle', 'neutral'],
  ] as const)('shows native %s instead of the git-checkout fallback', (phase, headline, tone) => {
    expect(describeUpdateStatus({ ...base, native: { ...native, phase } })).toMatchObject({ headline, tone, canRefresh: true });
  });
  it('labels an available update even when the version is not yet known', () => {
    expect(describeUpdateStatus({ ...base, native: { ...native, phase: 'available', version: null } }))
      .toMatchObject({ headline: 'Update available · downloads when idle', tone: 'info', canRefresh: true });
  });
  it('keeps the git facts fallback when there is no native state', () => {
    expect(describeUpdateStatus(base)).toMatchObject({ headline: 'Not running from a git checkout', tone: 'neutral', canRefresh: false });
  });
});
