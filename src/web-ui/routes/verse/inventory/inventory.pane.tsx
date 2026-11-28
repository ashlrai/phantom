import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-inventory', title: 'Inventory', icon: TasksGlyph, needsSession: false,
  description: 'Discover tools and check what is configured or ready.',
  component: lazyPane(() => import('./InventoryPane.js').then(m => m.InventoryPane)) });
