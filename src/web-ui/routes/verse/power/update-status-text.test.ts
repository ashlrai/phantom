import { describe, expect, it } from 'vitest';
import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import { updateStatusText } from './update-status-text.js';

const base: DesktopUpdateState = { phase: 'idle', enabled: true, version: '3.29.15', bytesReceived: 0, bytesTotal: null, reason: null };

describe('updateStatusText', () => {
  it('names the installed version when idle and says no installable newer release is on the feed', () => {
    expect(updateStatusText(base)).toEqual({
      badge: 'Up to date · v3.29.15',
      detail: 'No installable signed release newer than v3.29.15 is on the update feed.',
    });
  });
  it('stays sensible without a version', () => {
    const text = updateStatusText({ ...base, version: null });
    expect(text.badge).toBe('No newer signed release');
    expect(text.detail).toContain('No installable signed release newer than');
  });
  it('never claims a check happened because the state has no check time', () => {
    for (const phase of ['idle', 'current'] as const) {
      expect(JSON.stringify(updateStatusText({ ...base, phase }))).not.toMatch(/checked/iu);
    }
  });
  it('current has no newer-release line', () => {
    expect(updateStatusText({ ...base, phase: 'current' })).toEqual({ badge: 'Up to date · v3.29.15', detail: null });
  });
  it('shows the target version when an update is available', () => {
    expect(updateStatusText({ ...base, phase: 'available', version: '3.30.1' })).toEqual({ badge: 'Update available · v3.30.1', detail: null });
  });
  it('leaves failed unchanged', () => {
    expect(updateStatusText({ ...base, phase: 'failed', version: null })).toEqual({ badge: 'Update check failed', detail: null });
  });
});
