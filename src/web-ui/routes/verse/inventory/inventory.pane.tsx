import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-inventory', title: 'Inventory', icon: TasksGlyph, needsSession: false,
  description: 'Everything this install can use, each with its state.',
  component: lazyPane(() => import('./InventoryPane.js').then(m => m.InventoryPane)) });
