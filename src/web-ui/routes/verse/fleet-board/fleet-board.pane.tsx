import { TasksGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-board', title: 'Board', icon: TasksGlyph, needsSession: false,
  description: 'The Leader-as-CEO board — lanes, queue depth, merges and what needs Mason',
  component: lazyPane(() => import('./FleetBoardPane.js').then((module) => module.FleetBoardPane)),
});
