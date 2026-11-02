import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-outcomes.pane.js';

it('registers a session-independent Outcomes pane', () => {
  expect(getPane('fleet-outcomes')).toMatchObject({ id: 'fleet-outcomes', title: 'Outcomes', needsSession: false, description: 'What happened to each job the fleet executed: produced, verified, merged, reverted' });
});
