import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-worklog', title: 'Work log', icon: TasksGlyph, needsSession: false,
  description: 'The numbers to steer by, today against yesterday: PRs merged, time from PR opened to merged, merged PRs per launch and launches that ended with no change, with a trend line each and a table by lane and by repo.',
  component: lazyPane(() => import('./WorkLogPane.js').then(m => m.WorkLogPane)) });
