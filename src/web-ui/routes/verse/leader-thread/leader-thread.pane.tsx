import { ContextGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'leader-thread', title: 'Leaders', icon: ContextGlyph, needsSession: false,
  description: 'Talk with the fleet leaders and see their passes.',
  component: lazyPane(() => import('./LeaderThreadPane.js').then(m => m.LeaderThreadPane)),
});
