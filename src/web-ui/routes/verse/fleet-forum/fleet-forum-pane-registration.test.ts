import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-forum.pane.js';

it('registers a session-independent Forum pane', () => {
  expect(getPane('fleet-forum')).toMatchObject({
    id: 'fleet-forum', title: 'Forum', needsSession: false,
    description: 'Where the fleet talks, commits, and reviews its own work',
  });
});
