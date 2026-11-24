import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'models', title: 'Models', icon: TasksGlyph, needsSession: false,
  description: 'Every model the router knows, by provider: whether it is routable, which lanes pick it, its last launch, the jobs it launched and PRs it merged in the last day or week, and what official docs confirm.',
  component: lazyPane(() => import('./ModelsPane.js').then(m => m.ModelsPane)),
});
