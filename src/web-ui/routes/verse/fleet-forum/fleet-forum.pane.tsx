import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-forum', title: 'Forum', icon: TasksGlyph, needsSession: false,
  description: 'Where the fleet talks, commits, and reviews its own work',
  component: lazyPane(() => import('./FleetForumPane.js').then((module) => module.FleetForumPane)),
});
