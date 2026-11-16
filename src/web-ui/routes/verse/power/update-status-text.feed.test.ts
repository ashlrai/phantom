import { describe, expect, it } from 'vitest';
import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import { updateStatusText } from './update-status-text.js';

const base: DesktopUpdateState = { phase: 'idle', enabled: true, version: '3.29.15', bytesReceived: 0, bytesTotal: null, reason: null };

describe('update feed evidence', () => {
  it('reports an unavailable feed, including a 404', () => {
    expect(updateStatusText({ ...base, feed: { status: 'unavailable' } })).toEqual({
      badge: 'Update feed unavailable · v3.29.15',
      detail: 'The desktop update feed is unavailable; the latest release could not be checked.',
    });
  });
  it('reports a newer release without desktop files', () => {
    expect(updateStatusText({ ...base, feed: { status: 'missing-assets', newestVersion: '3.30.8' } })).toEqual({
      badge: 'Update feed unavailable · v3.29.15',
      detail: 'Newest release v3.30.8 has no desktop update files yet; this app stays on v3.29.15.',
    });
  });
  it('keeps idle wording after a successful feed read', () => {
    expect(updateStatusText({ ...base, feed: { status: 'ok' } }).badge).toBe('Up to date · v3.29.15');
  });
  it('requires evidence for current and idle', () => {
    for (const phase of ['idle', 'current'] as const) {
      expect(updateStatusText({ ...base, phase })).toEqual({ badge: 'v3.29.15 · last check result unknown', detail: null });
    }
    expect(updateStatusText({ ...base, phase: 'current', feed: { status: 'ok' } })).toEqual({ badge: 'Up to date · v3.29.15', detail: null });
  });
});
