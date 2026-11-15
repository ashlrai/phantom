import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'ideas', title: 'Ideas', icon: TasksGlyph, needsSession: false,
  description: 'What the fleet will pick next: ranked candidates by repo, and where they came from.',
  component: lazyPane(() => import('./IdeasPane.js').then(m => m.IdeasPane)),
});
