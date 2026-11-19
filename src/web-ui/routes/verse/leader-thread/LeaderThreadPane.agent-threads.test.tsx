import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { getDockState, resetDockStore } from '../dock/dock-store.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

beforeEach(() => {
  evictAll(); clearMutationToken(); resetDockStore();
  stubSurfaceFetch({ routes: { '/api/verse/leader/thread': { messages: [] }, '/api/verse/fleet/runs': { inbox: [] }, '/api/verse/leader/directives': { directives: [] } } });
});
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); resetDockStore(); });

it('opens every agent session as a thread beside the Leader conversation', () => {
  render(<LeaderThreadPane visible />);
  expect(getDockState().tabs).not.toContain('agent-threads');
  fireEvent.click(screen.getByRole('button', { name: 'Agent threads' }));
  expect(getDockState().tabs).toContain('agent-threads');
  expect(getDockState().active).toBe('agent-threads');
});
