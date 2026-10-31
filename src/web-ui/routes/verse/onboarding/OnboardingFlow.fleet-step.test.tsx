import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { getDockState, resetDockStore } from '../dock/dock-store.js';
import { registerBuiltinPanes, registerPane, resetPaneRegistry } from '../panes/index.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { OnboardingFlow } from './OnboardingFlow.js';
import { expandOnboarding, getOnboardingState, resetOnboarding } from './onboarding-store.js';

const Empty = () => null;

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetDockStore();
  resetVerseUi();
  resetOnboarding();
  resetPaneRegistry();
  expandOnboarding();
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
});

afterEach(() => {
  resetPaneRegistry();
  registerBuiltinPanes();
  vi.unstubAllGlobals();
});

async function reachFleet(user: ReturnType<typeof userEvent.setup>) {
  for (let i = 0; i < 4; i += 1) await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('fleet onboarding', () => {
  it('shows the points and opens the registered fleet panes, preserving navigation', async () => {
    registerPane({ id: 'fleet-lanes', title: 'Lanes', icon: Empty, component: Empty });
    registerPane({ id: 'fleet-inbox', title: 'Inbox', icon: Empty, component: Empty });
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await reachFleet(user);
    expect(screen.getByRole('heading', { name: 'Your fleet' })).toBeInTheDocument();
    expect(screen.getByText(/live jobs, lanes and merges from ~\/\.ashlr-runs on this Mac/)).toBeVisible();
    expect(screen.getByText(/prompts and interjections land in MASON-INBOX\.md.*leaders read every pass/)).toBeVisible();
    expect(screen.getByText(/HOLD, PAUSE.*Fleet ▸ Switches.*stop dispatch at once/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open fleet workspace' }));
    expect(getDockState()).toMatchObject({ open: true, tabs: ['fleet-lanes', 'fleet-inbox'] });
    expect(getOnboardingState()).toMatchObject({ open: true, step: 4 });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Turn on autonomy')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Three ways to stop')).toBeInTheDocument();
  });

  it('opens the fleet section when no fleet panes are registered', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await reachFleet(user);
    await user.click(screen.getByRole('button', { name: 'Open fleet workspace' }));
    expect(getVerseUiState().section).toBe('fleet');
    expect(getDockState().open).toBe(false);
    expect(getOnboardingState()).toMatchObject({ open: true, step: 4 });
  });
});
