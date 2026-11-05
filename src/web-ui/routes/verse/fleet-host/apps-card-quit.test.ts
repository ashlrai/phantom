import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { evictAll } from '../../../data/cache.js';
import { appActionsFor, type FleetApp } from './apps-card-model.js';
import { postAppAction } from './apps-action.js';
import { AppsCard } from './AppsCard.js';

vi.mock('./apps-action.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./apps-action.js')>()),
  postAppAction: vi.fn(),
}));

const at = '2026-11-02T00:00:00Z';
const row = (app: string, running: boolean | null): FleetApp => ({ app, running, checkedAt: at });
const fixture = { v: 1 as const, generatedAt: at, available: true, apps: [row('Cursor', true)] };

beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('offers quit for a running app, never for Phantom or a stopped app', () => {
  expect(appActionsFor(row('Cursor', true))).toEqual(['focus', 'restart', 'quit']);
  expect(appActionsFor(row('Phantom', true))).toEqual(['focus', 'restart']);
  expect(appActionsFor(row('Cursor', false))).toEqual(['launch']);
  expect(appActionsFor(row('Cursor', null))).toEqual(['launch']);
});

it('posts quit only after the second click', async () => {
  vi.mocked(postAppAction).mockResolvedValue({ app: 'Cursor', action: 'quit', code: 'stopped', at });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  render(createElement(AppsCard, { visible: true }));
  const button = await screen.findByRole('button', { name: 'quit Cursor' });
  fireEvent.click(button);
  expect(button).toHaveTextContent('Quit Cursor? click again');
  expect(postAppAction).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByText('Cursor: quit — stopped')).toBeInTheDocument();
  expect(postAppAction).toHaveBeenCalledExactlyOnceWith('Cursor', 'quit');
});
