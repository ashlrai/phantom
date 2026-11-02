import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-job-log.pane.js';

it('registers a session-independent worker log pane', () => {
  expect(getPane('worker-log')).toMatchObject({ id: 'worker-log', title: 'Worker log', needsSession: false });
});
