import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-org.pane.js';

it('registers a session-independent Org pane', () => {
  expect(getPane('fleet-org')).toMatchObject({ id: 'fleet-org', title: 'Org', needsSession: false });
});
