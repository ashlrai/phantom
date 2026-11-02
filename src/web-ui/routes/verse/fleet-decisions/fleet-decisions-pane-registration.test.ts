import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-decisions.pane.js';

it('registers a session-independent Decisions pane', () => {
  expect(getPane('fleet-decisions')).toMatchObject({ id: 'fleet-decisions', title: 'Decisions', needsSession: false, description: 'Why the router launched or skipped each item, and what is held' });
});
