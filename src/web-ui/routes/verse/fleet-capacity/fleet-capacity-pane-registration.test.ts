import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-capacity.pane.js';

it('registers a session-independent Capacity pane', () => {
  expect(getPane('fleet-capacity')).toMatchObject({ id: 'fleet-capacity', title: 'Capacity', needsSession: false, description: 'Per-lane running vs target over the last day, and where launches stalled' });
});
