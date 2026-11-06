import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSteeringPane } from './FleetSteeringPane.js';
import { requestSteeringFocus, takeSteeringFocus } from './steering-focus.js';

const props = { visible: true } as PaneProps;
const fixture = {
  sources: { runsDir: 'healthy', inbox: 'healthy' },
  inbox: [{ at: '2026-10-31 00:13', source: 'desktop', text: 'One shared context for every message' }],
  events: [{ at: '2026-10-31T00:14:00Z', kind: 'LEADER', text: 'Leader response' }],
};
const scroll = vi.fn();
beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  scroll.mockClear();
});
afterEach(() => { cleanup(); takeSteeringFocus(); vi.unstubAllGlobals(); });

it('waits for visible loaded orders, highlights and expands the match, and scrolls only once per request', async () => {
  requestSteeringFocus({ at: '2026-10-31T00:13:30Z', label: 'one shared context' });
  const view = render(<FleetSteeringPane {...props} visible={false} />);
  expect(scroll).not.toHaveBeenCalled();
  view.rerender(<FleetSteeringPane {...props} />);
  const list = await screen.findByRole('list', { name: 'Steering orders' });
  await waitFor(() => expect(list.querySelector('[aria-current="true"]')).toBeInTheDocument());
  const row = list.querySelector('[aria-current="true"]')!;
  expect(row).toHaveAttribute('data-focused', 'true');
  expect(within(row as HTMLElement).getByRole('button', { name: 'Hide events' })).toHaveAttribute('aria-expanded', 'true');
  expect(within(row as HTMLElement).getByText('Leader response')).toBeInTheDocument();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledWith({ block: 'center' });
  expect(takeSteeringFocus()).toBeNull();
  view.rerender(<FleetSteeringPane {...props} visible={false} />);
  view.rerender(<FleetSteeringPane {...props} />);
  expect(scroll).toHaveBeenCalledTimes(1);
  act(() => requestSteeringFocus({ at: '2026-10-31 00:13', label: 'ignored' }));
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
});

it('reports an unmatched order and consumes the request', async () => {
  requestSteeringFocus({ at: '2026-10-31T00:13:00Z', label: 'unrelated' });
  render(<FleetSteeringPane {...props} />);
  expect(await screen.findByText('Order not found in the current window')).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Steering orders' }).querySelector('[aria-current]')).toBeNull();
  expect(takeSteeringFocus()).toBeNull();
  expect(scroll).not.toHaveBeenCalled();
});
