import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'company', title: 'Company', icon: TasksGlyph, needsSession: false,
  description: 'Shared mission, agents, nodes, queue flow, quota and Slack presence',
  component: lazyPane(() => import('./CompanyPane.js').then(module => module.CompanyPane)),
});
