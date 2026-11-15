import { FocusGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'goals', title: 'Goals', icon: FocusGlyph, needsSession: false,
  description: 'Every open goal, its progress and next milestone, and the mission state.',
  component: lazyPane(() => import('./GoalsPane.js').then(m => m.GoalsPane)),
});
