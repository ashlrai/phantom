import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'home', title: 'Home', icon: TasksGlyph, needsSession: false,
  description: 'Is the fleet healthy and moving: merges, main, running jobs, blocked work, resources, the work log, Leader replies and disk.',
  component: lazyPane(() => import('./HomePane.js').then(m => m.HomePane)) });
