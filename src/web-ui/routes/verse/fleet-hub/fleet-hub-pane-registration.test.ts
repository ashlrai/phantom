import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-hub.pane.js';

it('registers a session-independent Fleet hub', () => {
  expect(getPane('fleet-hub')).toMatchObject({ id: 'fleet-hub', title: 'Fleet', description: 'Every fleet pane, one click', needsSession: false });
});
