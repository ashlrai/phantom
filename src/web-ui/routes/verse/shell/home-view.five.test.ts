import { describe, expect, it } from 'vitest';
import { HOME_COMPACT_BELOW, HOME_PANE_IDS, resolveHomeView } from './home-view.js';

const all = () => true;
const base = { width: 1440, hasLeaderThread: true, registered: all };

describe('resolveHomeView with five views', () => {
  it.each(['leader', 'feed', 'ideas', 'goals', 'library'] as const)('resolves a persisted %s when its pane is registered', (view) => {
    expect(resolveHomeView({ ...base, persisted: view }).view).toBe(view);
  });

  it('maps each view to its pane id', () => {
    expect(HOME_PANE_IDS).toEqual({ home: 'home', leader: 'leader-thread', feed: 'feed', ideas: 'ideas', goals: 'goals', library: 'library' });
  });

  it('falls back to leader when the picked pane is not registered', () => {
    expect(resolveHomeView({ ...base, persisted: 'goals', registered: (id) => id !== 'goals' }).view).toBe('leader');
    expect(resolveHomeView({ ...base, persisted: 'goals', registered: undefined }).view).toBe('leader');
  });

  it('falls back to live with no leader pane', () => {
    expect(resolveHomeView({ ...base, persisted: 'library', registered: () => false, hasLeaderThread: false }).view).toBe('live');
  });

  it.each([null, undefined, '', 'live', 'Goals', 'toString', 'v2-timeline', 42, {}])('ignores garbage or future value %j', (persisted) => {
    expect(resolveHomeView({ ...base, persisted }).view).toBe('leader');
  });

  it('keeps the 720 px layout boundary', () => {
    expect(resolveHomeView({ ...base, persisted: 'ideas', width: HOME_COMPACT_BELOW - 1 })).toEqual({ view: 'ideas', layout: 'compact' });
    expect(resolveHomeView({ ...base, persisted: 'ideas', width: HOME_COMPACT_BELOW })).toEqual({ view: 'ideas', layout: 'wide' });
  });

  it('lands on Home once its pane is registered, keeps Leader as the landing view without it, and opens every pick from Home', () => {
    expect(resolveHomeView({ ...base, persisted: null, hasHome: true }).view).toBe('home');
    expect(resolveHomeView({ ...base, persisted: 'home' }).view).toBe('leader');
    expect(resolveHomeView({ ...base, persisted: 'goals', registered: () => false, hasHome: true }).view).toBe('home');
    for (const view of ['home', 'leader', 'feed', 'ideas', 'goals', 'library'] as const) expect(resolveHomeView({ ...base, persisted: view, hasHome: true }).view).toBe(view);
    expect(resolveHomeView({ ...base, persisted: 'leader', hasHome: true, hasLeaderThread: false }).view).toBe('home');
  });
});
