import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-throughput', title: 'Throughput', icon: TasksGlyph, needsSession: false,
  description: 'Jobs launched, PRs published and merged as one flow over 6 hours, 24 hours or 7 days, with merges per hour, time to merge and empty jobs by lane.',
  component: lazyPane(() => import('./ThroughputPane.js').then(m => m.ThroughputPane)) });
