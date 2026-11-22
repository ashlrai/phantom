import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SESSION_THREAD_API } from '../fleet-sessions/session-thread-model.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import type { PaneHost } from '../panes/pane-registry.js';
import { LeaderSurface } from './LeaderSurface.js';
import { openConversationFromLeader } from './leader-reading.js';
import { rosterFleet } from './leader-roster.test-support.js';
import { readSurfaceView } from './surface-view-store.js';

beforeEach(() => { evictAll(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('persists a conversation opened from the chat, resizes it, and restores it through the real panes', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1280, height: 600, top: 0, left: 0, right: 1280, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  });
  const net = stubSurfaceFetch({ routes: {
    [LIVE_SESSIONS_API]: rosterFleet(),
    [SESSION_THREAD_API]: {
      schema: 'fleet.session-thread.v1', generatedAt: '2026-11-21T12:00:00Z',
      session: { id: 'RQ-A', jobId: 'RQ-A', kind: 'worker', state: 'running' },
      summary: [], messages: [], gaps: [], sources: {},
      reply: { to: 'job', job: 'RQ-A', hint: 'Reply to RQ-A' },
    },
  } });
  const host = { openPane: vi.fn() } as unknown as PaneHost;
  render(<LeaderSurface visible host={host} />);
  const leaderBox = await screen.findByRole('textbox', { name: 'Reply to the Leader' });
  leaderBox.focus();
  act(() => { expect(openConversationFromLeader('RQ-A')).toBe('leader'); });
  const opened = await screen.findByRole('region', { name: 'Session RQ-A' });
  expect(await within(opened).findByRole('textbox', { name: 'Message RQ-A' })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the session conversation' }), { key: 'ArrowLeft', shiftKey: true });
  expect(readSurfaceView()).toEqual({ session: 'RQ-A', split: 52 });
  cleanup();
  evictAll();
  render(<LeaderSurface visible host={host} />);
  const restored = await screen.findByRole('region', { name: 'Session RQ-A' });
  expect(restored.closest<HTMLElement>('[data-layout="beside"]')?.style.getPropertyValue('--reading-share')).toBe('52%');
  fireEvent.click(within(restored).getByRole('button', { name: 'Close this conversation' }));
  expect(readSurfaceView()).toEqual({ session: null, split: 52 });
  expect(host.openPane).not.toHaveBeenCalled();
  expect(net.posted).toEqual([]);
});
