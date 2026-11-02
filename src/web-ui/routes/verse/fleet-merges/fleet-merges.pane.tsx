import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  shortcut: 'mod+alt+o',
  id: 'fleet-merges', title: 'Merges', icon: TasksGlyph, needsSession: false,
  description: 'Merged PRs, pending publishes and lane throughput.',
  component: lazyPane(() => import('./FleetMergesPane.js').then(m => m.FleetMergesPane)),
});
