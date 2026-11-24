import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MapMessage } from '../../../../core/fleet/map-messages.js';
import { buildFleetLiveMap } from '../../../../core/fleet/live-map.js';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree } from '../../../../core/fleet/org-tree.js';
import { MapView } from './MapPane.js';
import { transientMessageEdges, MESSAGE_EDGE_TTL_MS } from './map-model.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const message: MapMessage = { id: 'one', from: 'comms', to: 'leader', fromNode: 'planner:comms', toNode: 'leader', kind: 'reply',
  at: new Date(now).toISOString(), summary: 'Finished', text: 'Finished the work. Full scrubbed text beyond the summary.' };
afterEach(() => { cleanup(); localStorage.clear(); });

it('creates a live edge only inside its ten-second lifetime', () => {
  expect(transientMessageEdges([message], now)).toMatchObject([{ id: 'live:one', from: 'planner:comms', to: 'leader' }]);
  expect(transientMessageEdges([message], now + MESSAGE_EDGE_TTL_MS - 1)).toHaveLength(1);
  for (const at of [now - 1, now + MESSAGE_EDGE_TTL_MS, now + 60_000]) expect(transientMessageEdges([message], at)).toEqual([]);
  expect(transientMessageEdges([{ ...message, at: 'bad' }, { ...message, fromNode: null }], now)).toEqual([]);
});

it.each(['2D', '3D'])('draws live edges on the existing %s map and opens text in place', mode => {
  const org = fleetOrgMap(null, { now });
  const map = buildFleetLiveMap({ now, org: { ...org, tree: fleetOrgTree(org) } });
  const props = { map, onOpen: () => {}, liveMessages: [message] };
  const view = render(<MapView {...props} now={now} />);
  if (mode === '3D') fireEvent.click(screen.getByRole('radio', { name: '3D' }));
  expect(view.container.querySelector('[data-open-messages="live:one"]')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Open planner Comms/ }).querySelector('[data-provider-badge]')).toBeTruthy();
  fireEvent.click(view.container.querySelector('[data-open-messages="live:one"]')!);
  expect(screen.getByRole('region', { name: 'Message text' }).textContent).toContain(message.text);
  view.rerender(<MapView {...props} now={now + MESSAGE_EDGE_TTL_MS} />);
  expect(view.container.querySelector('[data-open-messages="live:one"]')).toBeNull();
  expect(screen.getByRole('region', { name: 'Message text' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close message' }));
  expect(screen.queryByRole('region', { name: 'Message text' })).toBeNull();
});
