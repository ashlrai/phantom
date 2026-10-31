import { SourcesGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  shortcut: 'mod+alt+b',
  id: 'fleet-bus', title: 'Bus', icon: SourcesGlyph, needsSession: false,
  description: 'The shared agent message bus: events and hop totals.',
  component: lazyPane(() => import('./FleetBusPane.js').then(m => m.FleetBusPane)),
});
