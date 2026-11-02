import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { getAgentsFocus, takeAgentsFocus } from '../agents/agents-focus.js';
import { AgentsBoard } from '../agents/AgentsBoard.js';
import { CLAUDE_SEAT, installFetch, json } from '../context/context-fixtures.test-support.js';
import { resetOnboarding, getOnboardingState } from './onboarding-store.js';
import { FirstResultGuide } from './FirstResultGuide.js';

const emptyBoard = () => ({ generatedAt: new Date().toISOString(), cards: [],
  counts: { working: 0, 'needs-you': 0, review: 0, done: 0 }, cap: 25, liveWorkspaces: 0, supervisor: false });

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
    if (call.path === '/api/verse/agents') return json(emptyBoard());
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

it('opens the existing account page without invoking resource checks itself', async () => {
  const { calls } = installFetch(() => json(emptyBoard()));
  render(<FirstResultGuide />);
  fireEvent.click(screen.getByText('Get one verified result'));
  fireEvent.click(screen.getByRole('button', { name: 'Open Apps & Accounts' }));
  expect(getVerseUiState().section).toBe('apps');
  await screen.findByText(/No agent results yet/);
  expect(calls.every(call => call.method === 'GET' && call.path === '/api/verse/agents')).toBe(true);
});

it('does not query results until the guide is opened', () => {
  const { calls } = installFetch(() => json(emptyBoard()));
  render(<FirstResultGuide />);
  expect(calls).toHaveLength(0);
});

it('explains an empty result without completing onboarding or starting work', async () => {
  const { calls } = installFetch(() => json(emptyBoard()));
  render(<FirstResultGuide />);
  fireEvent.click(screen.getByText('Get one verified result'));
  await screen.findByText(/No agent results yet/);
  expect(screen.queryByRole('button', { name: 'Retry results' })).not.toBeInTheDocument();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/verse/agents' });
  expect(getOnboardingState().completedAt).toBeNull();
});

it.each(['unavailable', 'offline'])('explains %s results and retries the existing query', async failure => {
  let available = false;
  const { calls } = installFetch(() => {
    if (available) return json(emptyBoard());
    if (failure === 'offline') throw new TypeError('Failed to fetch');
    return json({ error: 'unavailable' }, 503);
  });
  render(<FirstResultGuide />);
  fireEvent.click(screen.getByText('Get one verified result'));
  await screen.findByText(/Agent results are unavailable/);
  expect(screen.queryByText(/No agent results yet/)).not.toBeInTheDocument();
  available = true;
  fireEvent.click(screen.getByRole('button', { name: 'Retry results' }));
  await screen.findByText(/No agent results yet/);
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.method === 'GET' && call.path === '/api/verse/agents')).toBe(true);
  expect(getOnboardingState().completedAt).toBeNull();
});

it('keeps a pending read distinct from an empty result', async () => {
  let resolve!: (response: Response) => void;
  installFetch(() => new Promise<Response>(done => { resolve = done; }));
  render(<FirstResultGuide />);
  fireEvent.click(screen.getByText('Get one verified result'));
  await screen.findByText('Checking agent results…');
  expect(screen.queryByText(/No agent results yet/)).not.toBeInTheDocument();
  resolve(json(emptyBoard()));
  await screen.findByText(/No agent results yet/);
});

it('keeps retry available when Phantom is still unavailable', async () => {
  const { calls } = installFetch(() => json({ error: 'unavailable' }, 503));
  render(<FirstResultGuide />);
  fireEvent.click(screen.getByText('Get one verified result'));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry results' }));
  await screen.findByRole('button', { name: 'Retry results' });
  expect(calls).toHaveLength(2);
  expect(screen.queryByText(/No agent results yet/)).not.toBeInTheDocument();
});
