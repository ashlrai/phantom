import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'models', title: 'Models', icon: TasksGlyph, needsSession: false,
  description: 'Every model the router knows, and whether official docs confirm its name.',
  component: lazyPane(() => import('./ModelsPane.js').then(m => m.ModelsPane)),
});
