import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
registerPane({ id: 'fleet-scoreboard', title: 'Scoreboard', icon: TasksGlyph, needsSession: false,
  description: 'What the fleet optimizes, with a trend for each number.',
  component: lazyPane(() => import('./ScoreboardPane.js').then(m => m.ScoreboardPane)) });
