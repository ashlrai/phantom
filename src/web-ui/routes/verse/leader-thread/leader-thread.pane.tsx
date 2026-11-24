import { ContextGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  shortcut: 'mod+alt+l',
  id: 'leader-thread', title: 'Leader', icon: ContextGlyph, needsSession: false,
  description: 'Talk with your engineering leader and see the current plan.',
  // The surface is the conversation with the "Working now" strip above it.
  component: lazyPane(() => import('./LeaderSurface.js').then(m => m.LeaderSurface)),
});
