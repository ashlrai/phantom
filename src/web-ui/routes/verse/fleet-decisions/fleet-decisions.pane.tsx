import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-decisions', title: 'Decisions', description: 'Why the router launched or skipped each item, and what is held',
  needsSession: false, icon: TasksGlyph,
  component: lazyPane(() => import('./FleetDecisionsPane.js').then(m => m.FleetDecisionsPane)),
});
