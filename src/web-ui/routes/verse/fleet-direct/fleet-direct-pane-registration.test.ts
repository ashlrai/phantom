import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-direct.pane.js';

it('registers a session-independent Direct pane', () => {
  expect(getPane('fleet-direct')).toMatchObject({ id: 'fleet-direct', title: 'Direct', needsSession: false });
});
