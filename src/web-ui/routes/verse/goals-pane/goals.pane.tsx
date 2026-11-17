import { FocusGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'goals', title: 'Goals', icon: FocusGlyph, needsSession: false,
  description: 'Fleet goals against their targets, behind first (phm goals), then every open goal, its progress and the mission state.',
  component: lazyPane(() => import('./GoalsPane.js').then(m => m.GoalsPane)),
});
