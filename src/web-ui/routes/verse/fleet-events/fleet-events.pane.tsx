import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  shortcut: 'mod+alt+e',
  id: 'fleet-events', title: 'Fleet events', icon: TasksGlyph, needsSession: false,
  description: 'Live dispatcher events and publishes.',
  component: lazyPane(() => import('./FleetEventsPane.js').then(m => m.FleetEventsPane)),
});
