import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-queue.pane.js';

it('registers a session-independent Queue pane', () => {
  expect(getPane('fleet-queue')).toMatchObject({ id: 'fleet-queue', title: 'Queue', needsSession: false });
});
