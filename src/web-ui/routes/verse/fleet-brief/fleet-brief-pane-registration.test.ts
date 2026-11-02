import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-brief.pane.js';

it('registers a session-independent Fleet brief pane', () => {
  expect(getPane('fleet-brief')).toMatchObject({ id: 'fleet-brief', title: 'Fleet brief', description: 'Copyable one-screen fleet status', needsSession: false });
});
