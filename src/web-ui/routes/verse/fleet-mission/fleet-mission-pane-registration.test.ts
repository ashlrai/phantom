import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-mission.pane.js';

it('registers a session-independent Mission pane', () => {
  expect(getPane('fleet-mission')).toMatchObject({
    id: 'fleet-mission',
    title: 'Mission',
    needsSession: false,
    description: 'Is the fleet healthy, what shipped, and what needs a look',
  });
});
