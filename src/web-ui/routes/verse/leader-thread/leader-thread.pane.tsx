import { ContextGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  shortcut: 'mod+alt+l',
  id: 'leader-thread', title: 'Leader', icon: ContextGlyph, needsSession: false,
  description: 'Talk with your engineering leader and see the current plan.',
  component: lazyPane(() => import('./LeaderThreadPane.js').then(m => m.LeaderThreadPane)),
});
