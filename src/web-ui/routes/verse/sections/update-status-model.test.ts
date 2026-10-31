import { describe, expect, it } from 'vitest';
import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import { describeUpdateStatus } from './update-status-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const facts: UpdateServerStatus = { v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: 'abcdef123456', headAt: null, originSha: null, branch: 'master', behind: 0, ahead: 0, dirty: false, lastFetchAt: '2026-01-01T00:00:00Z', processStartedAt: null, uptimeSeconds: 3660, canFastForward: true };
const native: DesktopUpdateState = { phase: 'idle', enabled: true, version: '2.0.0', bytesReceived: 25, bytesTotal: 100, reason: 'busy' };
const base = { native: null, server: facts, appVersion: '1.0.0', desktopVersion: null, now: Date.parse('2026-01-01T00:05:00Z') };

describe('describeUpdateStatus', () => {
  it.each([
    ['installing', 'Installing 2.0.0…', 'success'], ['installed', 'Installed 2.0.0; restarts when idle', 'success'],
    ['staged', 'Update 2.0.0 ready · installs when idle', 'info'], ['waiting-for-idle', 'Update 2.0.0 ready · installs when idle', 'info'],
    ['waiting-for-app-quit', 'Update 2.0.0 ready · installs when idle', 'info'], ['adoption-held', 'Update held: busy', 'warning'],
    ['downloading', 'Downloading 2.0.0 · 25%', 'info'], ['failed', 'Update failed: busy', 'danger'],
    ['disabled', 'Automatic updates off', 'neutral'], ['uncommissioned', 'Automatic updates off', 'neutral'],
  ] as const)('prioritizes native %s', (phase, headline, tone) => {
    expect(describeUpdateStatus({ ...base, native: { ...native, phase } })).toMatchObject({ headline, tone, canRefresh: true });
  });
  it.each([
    [{ behind: 3, canFastForward: true }, '3 commits behind master · ready to fast-forward', 'info'],
    [{ behind: 3, canFastForward: false, dirty: true }, '3 behind · local changes block the update', 'warning'],
    [{ behind: 3, canFastForward: false }, '3 behind · fast-forward unavailable', 'warning'],
    [{ behind: 0 }, 'Up to date with master', 'success'],
    [{ sourceState: 'unavailable' as const }, 'Not running from a git checkout', 'neutral'],
  ] as const)('describes server facts %j', (patch, headline, tone) => {
    expect(describeUpdateStatus({ ...base, server: { ...facts, ...patch } })).toMatchObject({ headline, tone, canRefresh: false });
  });
  it('shows missing endpoint and unknown reads without inventing status', () => {
    expect(describeUpdateStatus({ ...base, server: { kind: 'notInBuild' } }).headline).toBe('Update status is not in this build yet');
    expect(describeUpdateStatus({ ...base, server: null }).headline).toBe('Update status unavailable');
    expect(describeUpdateStatus({ ...base, nativeBridge: true }).canRefresh).toBe(true);
  });
  it('shows build, abbreviated sha, uptime, fetch age and native build', () => {
    expect(describeUpdateStatus({ ...base, desktopVersion: '2.0.0' }).detail).toBe('Phantom 1.0.0 · desktop 2.0.0 · abcdef1 · up 1h · fetched 5m ago');
    expect(describeUpdateStatus({ ...base, server: { ...facts, headSha: null, uptimeSeconds: null, lastFetchAt: null } }).detail).toBe('Phantom 1.0.0 · fetched never');
    expect(describeUpdateStatus({ ...base, server: null }).detail).toBe('Phantom 1.0.0');
  });
  it('handles missing native progress and reason', () => {
    expect(describeUpdateStatus({ ...base, native: { ...native, phase: 'downloading', bytesTotal: null } }).headline).toBe('Downloading 2.0.0');
    expect(describeUpdateStatus({ ...base, native: { ...native, phase: 'failed', reason: null } }).headline).toBe('Update failed: reason unavailable');
  });
});
