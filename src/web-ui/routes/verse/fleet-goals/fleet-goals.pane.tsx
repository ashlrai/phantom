import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-goals', title: 'Goals', icon: TasksGlyph, needsSession: false,
  description: 'Throughput, empty runs and resource resets.',
  component: lazyPane(() => import('./GoalsPane.js').then(m => m.GoalsPane)) });
