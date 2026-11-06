import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-dispatch.pane.js';

it('registers a lazy Dispatch pane without a session requirement', () => {
  expect(getPane('fleet-dispatch')).toMatchObject({
    title: 'Dispatch', needsSession: false,
    description: 'Per-lane verdicts: why work is or is not launching, and the next action',
  });
  expect(getPane('fleet-dispatch')?.component).toHaveProperty('preload', expect.any(Function));
});
