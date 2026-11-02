import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-channels.pane.js';

it('registers a session-independent Channels pane', () => {
  expect(getPane('fleet-channels')).toMatchObject({ id: 'fleet-channels', title: 'Channels', needsSession: false, description: 'Which channels Mason has been heard from, and when, in the shared inbox' });
});
