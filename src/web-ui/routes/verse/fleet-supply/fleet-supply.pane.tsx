import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  shortcut: 'mod+alt+u',
  id: 'fleet-supply', title: 'Supply', icon: TasksGlyph, needsSession: false,
  description: 'How many job files each lane needs to stay full.',
  component: lazyPane(() => import('./FleetSupplyPane.js').then(m => m.FleetSupplyPane)),
});
