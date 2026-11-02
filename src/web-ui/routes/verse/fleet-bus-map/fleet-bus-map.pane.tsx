import { ContextGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'fleet-bus-map', title: 'Bus map', icon: ContextGlyph, needsSession: false,
  description: 'Who talks to whom on the agent bus, and what it costs.',
  component: lazyPane(() => import('./FleetBusMapPane.js').then(m => m.FleetBusMapPane)),
});
