import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './leader-journal.pane.js';
import { DISCOVERED_PANE_MODULES } from '../panes/index.js';

it('discovers and registers the session-independent leader journal pane', () => {
  expect(Object.keys(DISCOVERED_PANE_MODULES)).toContain('../leader-journal/leader-journal.pane.tsx');
  expect(getPane('leader-journal')).toMatchObject({ id: 'leader-journal', title: 'Leader journal', needsSession: false,
    description: 'What the leaders saw and did each pass, and which job files the drop accepted or rejected' });
});
