import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { QueryEntry } from '../../../data/cache.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { PaneHost } from '../panes/pane-registry.js';
import { LeaderSurface } from './LeaderSurface.js';
import { takeLeaderDraft } from './leader-draft-store.js';
import { rosterFleet } from './leader-roster.test-support.js';
import { readSurfaceView, SURFACE_VIEW_KEY, writeSurfaceView } from './surface-view-store.js';

// Only the shared live-query boundary is controlled; the surface, roster,
// composer, reading/focus hooks and session component execute normally.
const query = vi.hoisted(() => ({ snapshot: { data: undefined, status: 'idle', updatedAt: null, error: undefined } as QueryEntry<LiveSessionsV1 | null> }));
vi.mock('../../../data/hooks.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../data/hooks.js')>();
  return { ...actual, useQuery: (...args: Parameters<typeof actual.useQuery>) =>
    args[0].key === 'verse-fleet-live-sessions' ? query.snapshot : actual.useQuery(...args) };
});

let width = 1280;
let resized: () => void;
const host = { openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() } as unknown as PaneHost;
const surface = () => <LeaderSurface visible host={host} />;
const stored = (session: unknown = 'RQ-A', split: unknown = 44) => window.localStorage.setItem(SURFACE_VIEW_KEY, JSON.stringify({ session, split }));
const session = () => screen.queryByRole('region', { name: 'Session RQ-A' });
const answer = (data: LiveSessionsV1 | null = { ...rosterFleet(), live: true }, status: QueryEntry<LiveSessionsV1 | null>['status'] = 'success') => {
  query.snapshot = { data, status, updatedAt: Date.now() + 1, error: undefined };
};

beforeEach(() => {
  evictAll(); window.localStorage.clear(); takeLeaderDraft(); width = 1280;
  query.snapshot = { data: undefined, status: 'loading', updatedAt: null, error: undefined };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(node: HTMLElement) { if (node.className.includes('surface')) resized = this.callback; }
    disconnect() {} unobserve() {}
  });
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'fake-message', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
  } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('waits for a new live success, restores beside the draft, and keeps close closed across remount', async () => {
  stored();
  answer(); // Cached before the surface mounted: insufficient evidence.
  const view = render(surface());
  const box = await screen.findByRole('textbox', { name: 'Reply to the Leader' });
  fireEvent.change(box, { target: { value: 'unfinished fake thought' } });
  box.focus();
  expect(session()).toBeNull();
  answer(rosterFleet(), 'refreshing'); view.rerender(surface());
  expect(session()).toBeNull();
  answer(); view.rerender(surface());
  await waitFor(() => expect(session()).toBeInTheDocument());
  expect(box).toHaveFocus();
  expect(box).toHaveValue('unfinished fake thought');
  expect(session()?.closest('[data-layout]')).toHaveAttribute('data-layout', 'beside');
  width = 640; act(() => resized());
  expect(box.closest('[hidden]')).not.toBeNull();
  width = 1280; act(() => resized());
  expect(screen.getByRole('textbox', { name: 'Reply to the Leader' })).toBe(box);
  expect(box).toHaveValue('unfinished fake thought');
  fireEvent.click(screen.getByRole('button', { name: 'Close this conversation' }));
  expect(screen.getByRole('button', { name: 'Read RQ-A as a conversation' })).toHaveFocus();
  expect(readSurfaceView().session).toBeNull();
  expect(window.localStorage.getItem(SURFACE_VIEW_KEY)).not.toContain('unfinished');
  view.unmount(); render(surface());
  expect(session()).toBeNull();
});

it('retains a saved choice at unmeasured and narrow widths, then restores when wide', () => {
  stored(); width = 0;
  const view = render(surface());
  answer(); view.rerender(surface());
  expect(session()).toBeNull(); expect(readSurfaceView().session).toBe('RQ-A');
  width = 640; act(() => resized());
  expect(session()).toBeNull(); expect(readSurfaceView().session).toBe('RQ-A');
  width = 1280; act(() => resized());
  expect(session()).toBeInTheDocument();
});

it.each(['loading', 'error', 'success'] as const)('does not erase a saved choice on an unavailable %s read', status => {
  stored();
  const view = render(surface());
  answer(null, status); view.rerender(surface());
  expect(session()).toBeNull(); expect(readSurfaceView().session).toBe('RQ-A');
  answer({ ...rosterFleet(), live: false }); view.rerender(surface());
  expect(session()).toBeNull(); expect(readSurfaceView().session).toBe('RQ-A');
  answer(); view.rerender(surface());
  expect(session()).toBeInTheDocument();
});

it.each(['RQ-STALE', 'unknown parent', 'not an id', '', null])('never restores invalid or stale choice %s', id => {
  stored(id);
  const view = render(surface());
  answer(); view.rerender(surface());
  expect(screen.queryByRole('region', { name: /^Session / })).toBeNull();
  expect(readSurfaceView().session).toBeNull();
});

it.each(['{broken', 'null', '[]', '42'])('ignores malformed storage %s', raw => {
  window.localStorage.setItem(SURFACE_VIEW_KEY, raw);
  const view = render(surface()); answer(); view.rerender(surface());
  expect(session()).toBeNull();
});

it('keeps roster open/close usable when storage reads and writes are denied', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('fake storage denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('fake storage denied'); });
  answer(); render(surface());
  fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));
  expect(session()).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close this conversation' }));
  expect(session()).toBeNull();
});

it.each([[200, 64], [-20, 28], [12.7, 28], [48.6, 49], ['invalid', 44]])('bounds the only numeric metadata %s', (input, expected) => {
  stored('RQ-A', input); render(surface());
  writeSurfaceView({ session: null });
  expect(JSON.parse(window.localStorage.getItem(SURFACE_VIEW_KEY)!)).toEqual({ session: null, split: expected });
});

it.each([NaN, Infinity, -Infinity])('rejects nonfinite divider writes %s', split => {
  render(surface()); writeSurfaceView({ session: 'RQ-A', split });
  expect(readSurfaceView()).toEqual({ session: 'RQ-A', split: 44 });
});

it('persists an explicit open and revalidates it after remount', async () => {
  answer();
  const first = render(surface());
  fireEvent.click(await screen.findByRole('button', { name: 'Read RQ-A as a conversation' }));
  expect(readSurfaceView().session).toBe('RQ-A');
  first.unmount();
  const second = render(surface());
  expect(session()).toBeNull();
  answer(); second.rerender(surface());
  expect(session()).toBeInTheDocument();
});
