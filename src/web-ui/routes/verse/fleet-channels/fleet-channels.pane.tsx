import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-channels', title: 'Channels', icon: TasksGlyph, needsSession: false,
  description: 'Which channels Mason has been heard from, and when, in the shared inbox',
  component: lazyPane(() => import('./FleetChannelsPane.js').then(m => m.FleetChannelsPane)),
});
