import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-metrics', title: 'Metrics', icon: TasksGlyph, needsSession: false,
  description: 'Merge speed and lane capacity.',
  component: lazyPane(() => import('./MetricsPane.js').then(m => m.MetricsPane)) });
