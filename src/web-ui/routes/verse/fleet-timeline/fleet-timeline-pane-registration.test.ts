import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-timeline.pane.js';

it('registers a session-independent Worker timeline pane', () => {
  expect(getPane('fleet-timeline')).toMatchObject({ id: 'fleet-timeline', title: 'Worker timeline', needsSession: false });
});
