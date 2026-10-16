import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { getAgentsFocus, takeAgentsFocus } from '../agents/agents-focus.js';
import { AgentsBoard } from '../agents/AgentsBoard.js';
import { CLAUDE_SEAT, installFetch, json } from '../context/context-fixtures.test-support.js';
import { resetOnboarding, getOnboardingState } from './onboarding-store.js';
import { FirstResultGuide } from './FirstResultGuide.js';

beforeEach(() => {
  evictAll();
  resetVerseUi();
  resetOnboarding();
  const focus = getAgentsFocus();
  if (focus) takeAgentsFocus(focus.seq);
});
afterEach(() => vi.unstubAllGlobals());

it('opens the existing agent form without sending a task or claiming an accepted result', async () => {
  const { calls } = installFetch(call => {
    if (call.path === '/api/verse/agents') return json({ generatedAt: new Date().toISOString(), cards: [],
      counts: { working: 0, 'needs-you': 0, review: 0, done: 0 }, cap: 25, liveWorkspaces: 0, supervisor: false });
    if (call.path.startsWith('/api/verse/bootstrap')) return json({ seats: [CLAUDE_SEAT],
      projects: [{ path: '/repo', name: 'Repo', enrolled: true }], sessions: [], dispatchEnabled: true });
    if (call.path.startsWith('/api/verse/agents/config')) return json({ config: { setup: null, run: [], ports: 0 }, source: 'default', warnings: [] });
    return json({ error: 'not found' }, 404);
  });
  render(<><FirstResultGuide /><AgentsBoard /></>);
  fireEvent.click(screen.getByText('Get one verified result'));
  fireEvent.click(screen.getByRole('button', { name: 'Choose a first task' }));
  await screen.findByRole('dialog', { name: 'New agent' });
  expect(getVerseUiState().section).toBe('agents');
  expect(screen.getByLabelText('What should it do?')).toHaveValue('');
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  expect(getOnboardingState().completedAt).toBeNull();
});

it('opens the existing account page without invoking resource checks itself', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<FirstResultGuide />);
  fireEvent.click(screen.getByText('Get one verified result'));
  fireEvent.click(screen.getByRole('button', { name: 'Open Apps & Accounts' }));
  expect(getVerseUiState().section).toBe('apps');
  expect(fetch).not.toHaveBeenCalled();
});
