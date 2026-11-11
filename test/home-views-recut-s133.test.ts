import { describe, expect, it } from 'vitest';
import { HOME_PANE_IDS, resolveHomeView } from '../src/web-ui/routes/verse/shell/home-view.js';

describe('home view selection', () => {
  it.each(['ideas', 'goals', 'library'] as const)('opens the registered %s pane and falls back when absent', (choice) => {
    const input = { persisted: choice, width: 500, hasLeaderThread: true };
    expect(resolveHomeView({ ...input, registered: (id) => id === HOME_PANE_IDS[choice] })).toEqual({ view: choice, layout: 'compact' });
    expect(resolveHomeView({ ...input, registered: () => false })).toEqual({ view: 'leader', layout: 'compact' });
  });

  it('does not accept inherited properties as home choices', () => {
    expect(resolveHomeView({ persisted: 'toString', width: 900, hasLeaderThread: false, registered: () => true })).toEqual({ view: 'live', layout: 'wide' });
  });
});
