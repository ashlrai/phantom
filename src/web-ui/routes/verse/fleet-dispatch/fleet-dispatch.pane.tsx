import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-dispatch', title: 'Dispatch', icon: TasksGlyph, needsSession: false,
  description: 'Per-lane verdicts: why work is or is not launching, and the next action',
  component: lazyPane(() => import('./FleetDispatchPane.js').then(m => m.FleetDispatchPane)),
});
