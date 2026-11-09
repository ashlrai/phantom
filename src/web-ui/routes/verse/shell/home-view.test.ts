import { describe, expect, it } from 'vitest';
import { HOME_COMPACT_BELOW, homeLayoutFor, resolveHomeView } from './home-view.js';

describe('resolveHomeView', () => {
  it('defaults to the Leader thread on a fresh profile', () => {
    expect(resolveHomeView({ persisted: null, width: 1440, hasLeaderThread: true })).toEqual({ view: 'leader', layout: 'wide' });
  });

  it('respects an explicit last choice', () => {
    expect(resolveHomeView({ persisted: 'feed', width: 1440, hasLeaderThread: true }).view).toBe('feed');
  });

  it('ignores a stored value it does not know', () => {
    expect(resolveHomeView({ persisted: { view: 'nope' }, width: 1440, hasLeaderThread: true }).view).toBe('leader');
  });

  it('is compact under 720 and wide from 720', () => {
    expect(resolveHomeView({ persisted: null, width: 600, hasLeaderThread: true }).layout).toBe('compact');
    expect(homeLayoutFor(HOME_COMPACT_BELOW - 1)).toBe('compact');
    expect(homeLayoutFor(HOME_COMPACT_BELOW)).toBe('wide');
  });

  it('falls back to the old Home when no Leader pane is registered', () => {
    expect(resolveHomeView({ persisted: null, width: 1440, hasLeaderThread: false }).view).toBe('live');
  });
});
