import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { registerPane } from '../panes/pane-registry.js';
import { CompactNavStrip } from './CompactNavStrip.js';
import { HomeSurface } from './HomeSurface.js';
import { HOME_PANE_IDS } from './home-view.js';
import { resetHomeChoice, setHomeChoice, useHomeView } from './home-view-store.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetHomeChoice();
});

it('opens a selected home pane and falls back when that pane is removed', async () => {
  const dispose = registerPane({ id: 'goals', title: 'Goals', icon: () => null, component: () => <div>Goals content</div> });
  function Shell() {
    const { view } = useHomeView();
    return <>
      <CompactNavStrip active={view === 'live' ? null : view} needsYouCount={null} onSelect={(id) => {
        if (id !== 'needs-you' && id !== 'fleet') setHomeChoice(id);
      }} />
      {view !== 'live' && <HomeSurface paneId={HOME_PANE_IDS[view]} visible compact />}
    </>;
  }
  render(<Shell />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Goals' }));
  expect(screen.getByText('Goals content')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Goals' }).getAttribute('aria-current')).toBe('page');
  act(() => dispose());
  expect(screen.queryByText('Goals content')).toBeNull();
  expect(screen.getByRole('button', { name: 'Leader' }).getAttribute('aria-current')).toBe('page');
});
