import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-tools', title: 'Tools', icon: TasksGlyph, needsSession: false,
  description: 'Which lane has which tool, and the biggest gaps.',
  component: lazyPane(() => import('./ToolsPane.js').then(m => m.ToolsPane)) });
