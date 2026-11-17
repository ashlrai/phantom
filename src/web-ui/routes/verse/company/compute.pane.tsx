import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-compute', title: 'Fleet compute', icon: TasksGlyph, needsSession: false,
  description: 'Live compute, lane quotas and agent sessions in 2D and 3D',
  component: lazyPane(() => import('./ComputeMap.js').then(module => module.ComputeMap)),
});
