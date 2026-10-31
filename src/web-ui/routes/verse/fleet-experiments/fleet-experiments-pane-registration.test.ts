import { expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './fleet-experiments.pane.js';

it('registers a session-independent Experiments pane', () => {
  expect(getPane('fleet-experiments')).toMatchObject({ id: 'fleet-experiments', title: 'Experiments', needsSession: false, description: 'Is self-improvement real: lift and confidence interval per calibration experiment' });
});
