import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetEventsPane } from './FleetEventsPane.js';

const props = { visible: true } as PaneProps;
const event = (at: string, kind: string, text: string) => ({ at, kind, text });
const fixture = () => ({
  events: [
    event('2026-01-01T00:00:00Z', 'launch', 'launched job RQ-FAKE-1 in lane dev'),
    event('2026-01-02T00:00:00Z', 'hold', 'job RQ-FAKE-1 held by steward'),
    event('2026-01-03T00:00:00Z', 'merge', 'merged lane docs'),
    event('2026-01-04T00:00:00Z', 'publish', 'published job RQ-OTHER-9'),
  ],
  leaders: [], drop: { pending: [], done: 0 }, sources: { runsDir: 'healthy' },
});
const feed = () => within(screen.getByRole('list', { name: 'Fleet event feed' })).getAllByRole('listitem');
const box = () => screen.getByRole('textbox', { name: 'Filter events' });
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('narrows the feed to matching events, reports shown counts and composes with the kind filter', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetEventsPane {...props} />);
  await screen.findByText('merged lane docs');
  expect(feed()).toHaveLength(4);

  fireEvent.change(box(), { target: { value: 'rq-fake-1' } });
  expect(feed().map(row => row.textContent)).toHaveLength(2);
  expect(feed().every(row => row.textContent?.includes('RQ-FAKE-1'))).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent('2 of 4 shown');

  fireEvent.change(box(), { target: { value: '' } });
  expect(feed()).toHaveLength(4);
  expect(screen.queryByRole('status')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'publish' }));
  expect(feed()).toHaveLength(1);
  fireEvent.change(box(), { target: { value: 'zzz-no-match' } });
  expect(screen.queryByRole('list', { name: 'Fleet event feed' })).toBeNull();
  expect(screen.getByText('No events match this filter.')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('0 of 1 shown');
});
