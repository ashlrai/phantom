import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-plugins', title: 'Plugins', icon: TasksGlyph, needsSession: false,
  description: 'Plugins fleet agents have.',
  component: lazyPane(() => import('./InstalledPane.js').then(m => m.PluginsPane)) });
registerPane({ id: 'fleet-skills', title: 'Skills', icon: TasksGlyph, needsSession: false,
  description: 'Skills fleet agents have.',
  component: lazyPane(() => import('./InstalledPane.js').then(m => m.SkillsPane)) });
