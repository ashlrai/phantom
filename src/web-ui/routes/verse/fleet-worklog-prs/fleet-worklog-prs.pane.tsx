import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-worklog-prs', title: 'Shipped PRs', icon: TasksGlyph, needsSession: false,
  description: 'What the fleet shipped, newest first: one line per merged PR with its lane, model and minutes to merge, grouped by hour with a count per hour. Up and Down pick a PR, Enter opens it.',
  component: lazyPane(() => import('./WorkLogPrsPane.js').then(m => m.WorkLogPrsPane)) });
