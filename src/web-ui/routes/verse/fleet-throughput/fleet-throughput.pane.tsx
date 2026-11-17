import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-throughput', title: 'Throughput', icon: TasksGlyph, needsSession: false,
  description: 'PRs merged per hour, time to merge and empty jobs by lane.',
  component: lazyPane(() => import('./ThroughputPane.js').then(m => m.ThroughputPane)) });
