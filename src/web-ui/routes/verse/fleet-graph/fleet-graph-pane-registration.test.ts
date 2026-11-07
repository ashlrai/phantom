import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-graph.pane.js';

it('registers a session-independent Graph pane', () => {
  expect(getPane('fleet-graph')).toMatchObject({ id: 'fleet-graph', title: 'Graph', description: 'Leaders, lanes and workers as a live graph', needsSession: false });
});
