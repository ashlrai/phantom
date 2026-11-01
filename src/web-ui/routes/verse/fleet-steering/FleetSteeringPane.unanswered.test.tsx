import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSteeringPane } from './FleetSteeringPane.js';

const now = Date.parse('2026-10-31T16:00:00Z');
const props = { visible: true } as PaneProps;
const order = (at: string, source: string, text: string) => ({ at, source, text });
const snapshot = (inbox: ReturnType<typeof order>[], events: object[] = []) => ({
  sources: { runsDir: 'healthy', inbox: 'healthy' }, inbox, events,
});
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows unanswered orders oldest first with previews and links to their existing rows', async () => {
  const longText = 'a'.repeat(80) + 'fake tail';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot([
    order('2026-10-31 11:50', 'Chat', 'Fake recent order'),
    order('2026-10-31 11:15', 'Desktop', longText),
    order('2026-10-31 09:00', 'Telegram', 'Fake held order'),
    order('2026-10-31 10:00', 'Chat', 'Fake launched order'),
  ], [
    { at: '2026-10-31T09:01:00Z', kind: 'LANE_HOLD', text: 'Fake hold' },
    { at: '2026-10-31T10:01:00Z', kind: 'LAUNCH', text: 'Fake launch' },
  ]))));
  render(<FleetSteeringPane {...props} />);
  const strip = await screen.findByRole('region', { name: 'Unanswered orders' });
  expect(strip).toHaveAttribute('data-tone', 'bad');
  expect(strip).toHaveTextContent('2 orders have had no leader reaction for 30+ min; oldest 3 h (Telegram).');
  const rows = within(strip).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('3 h · Telegram · Fake held order');
  expect(rows[1]).toHaveTextContent(`45 min · Desktop · ${'a'.repeat(80)}…`);
  expect(strip).not.toHaveTextContent('fake tail');
  const targetId = within(rows[0]!).getByRole('link', { name: 'Jump' }).getAttribute('href')!.slice(1);
  const target = document.getElementById(targetId)!;
  expect(target).toHaveTextContent('Fake held order');
  target.scrollIntoView = vi.fn();
  const hash = window.location.hash;
  fireEvent.click(within(rows[0]!).getByRole('link', { name: 'Jump' }));
  expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  expect(window.location.hash).toBe(hash);
});

it('renders no strip when all orders are young or answered', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot([
    order('2026-10-31 11:50', 'Chat', 'Fake recent order'),
    order('2026-10-31 10:00', 'Chat', 'Fake answered order'),
  ], [{ at: '2026-10-31T10:01:00Z', kind: 'LEADER', text: 'Fake pass' }]))));
  render(<FleetSteeringPane {...props} />);
  await screen.findByRole('list', { name: 'Steering orders' });
  expect(screen.queryByRole('region', { name: 'Unanswered orders' })).toBeNull();
});

it('limits the strip to five and gives matching timestamps and sources distinct targets', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot(Array.from({ length: 6 }, (_, i) =>
    order('2026-10-31 09:00', 'Chat', `Fake order ${i}`))))));
  render(<FleetSteeringPane {...props} />);
  const strip = await screen.findByRole('region', { name: 'Unanswered orders' });
  const links = within(strip).getAllByRole('link', { name: 'Jump' });
  expect(links).toHaveLength(5);
  expect(new Set(links.map(link => link.getAttribute('href'))).size).toBe(5);
  for (const [index, link] of links.entries()) {
    expect(document.getElementById(link.getAttribute('href')!.slice(1))).toHaveTextContent(`Fake order ${index}`);
  }
});
