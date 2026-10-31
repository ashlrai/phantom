import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-experiments', title: 'Experiments', needsSession: false, icon: TasksGlyph,
  description: 'Is self-improvement real: lift and confidence interval per calibration experiment',
  component: lazyPane(() => import('./FleetExperimentsPane.js').then(m => m.FleetExperimentsPane)),
});
