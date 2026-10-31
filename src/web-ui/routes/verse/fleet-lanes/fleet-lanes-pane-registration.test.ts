import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-lanes.pane.js';

it('registers a session-independent Lanes pane', () => {
  expect(getPane('fleet-lanes')).toMatchObject({ id: 'fleet-lanes', title: 'Lanes', needsSession: false, description: 'Live lanes, workers and merges from the Mac fleet' });
});
