import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-observe.pane.js';

it('registers a session-independent Observe pane', () => {
  expect(getPane('fleet-observe')).toMatchObject({ id: 'fleet-observe', title: 'Observe', needsSession: false });
});
