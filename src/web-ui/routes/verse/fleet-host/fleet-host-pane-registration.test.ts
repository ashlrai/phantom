import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-host.pane.js';

it('registers a session-independent Mac host pane', () => {
  expect(getPane('fleet-host')).toMatchObject({ id: 'fleet-host', title: 'Mac host', needsSession: false, description: 'Memory, disk, tick and switches on the fleet Mac' });
});
