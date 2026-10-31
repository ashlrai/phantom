import { describe, expect, it, vi } from 'vitest';
import { deriveFleetMergeNotifications as derive } from './deriveFleetMergeNotifications.js';
import { setVerseSection } from '../../routes/verse/verse-ui-store.js';
import { parseDeepLink } from '../../routes/verse/shell/deep-link.js';

vi.mock('../../routes/verse/verse-ui-store.js', () => ({ setVerseSection: vi.fn() }));

const now = Date.parse('2026-10-31T12:15:00Z');
const snapshot = (items: unknown[]) => ({
  generatedAt: new Date(now).toISOString(), sources: { merges: 'healthy' },
  mergesLastHour: { count: items.length, items },
});

describe('fleet merge notification targets', () => {
  it('opens desktop update settings for a release with its original id', () => {
    const [notification] = derive(snapshot([
      { repo: 'ashlrai/phantom', number: 2124, title: 'chore(master): release 3.30.0' },
    ]), now);
    expect(notification).toMatchObject({ id: 'fleet-release:ashlrai/phantom:3.30.0', actionLabel: 'Update' });
    expect(notification?.actionHref).toBeUndefined();
    expect(notification?.actionRun).toBeTypeOf('function');
    notification?.actionRun?.();
    expect(setVerseSection).toHaveBeenCalledWith('settings', 'desktop-updates');
  });

  it('opens the GitHub PR with its original id', () => {
    const [notification] = derive(snapshot([
      { repo: 'ashlrai/phantom', number: 2124, title: 'Fix notifications' },
    ]), now);
    expect(notification).toMatchObject({ id: 'fleet-merge:ashlrai/phantom#2124',
      actionHref: 'https://github.com/ashlrai/phantom/pull/2124', actionLabel: 'Open PR' });
  });

  it.each([
    { repo: 'ashlrai/phantom', title: 'Missing number' },
    { number: 2124, title: 'Missing repo' },
    { repo: 'phantom', number: 2124, title: 'Missing owner' },
    { repo: 'ashlrai/phantom/extra', number: 2124, title: 'Extra path' },
    { repo: 'ashlrai/..', number: 2124, title: 'Unsafe path' },
    { repo: 'ashlrai/phantom\n', number: 2124, title: 'Trailing newline' },
  ])('falls back to merges for $title', (item) => {
    const [notification] = derive(snapshot([item]), now);
    expect(notification?.actionLabel).toBe('Open merges');
    expect(parseDeepLink(new URL(notification!.actionHref!).search))
      .toEqual({ paneId: 'fleet-merges', sessionId: null });
  });
});
