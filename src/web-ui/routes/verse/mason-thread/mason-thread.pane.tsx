import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'mason-thread', title: 'Mason', icon: TasksGlyph, needsSession: false,
  description: 'One timeline with Mason across every channel, each message with its reply state and jobs',
  component: lazyPane(() => import('./MasonThreadPane.js').then(m => m.MasonThreadPane)),
});
