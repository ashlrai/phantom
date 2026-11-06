import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-releases.pane.js';

it('registers a session-independent Releases pane', () => {
  expect(getPane('fleet-releases')).toMatchObject({ id: 'fleet-releases', title: 'Releases', needsSession: false,
    description: 'Release train per enrolled repo: version, tag, latest release and workflow run' });
});
