import { SourcesGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  shortcut: 'mod+alt+i',
  id: 'fleet-inbox', title: "Leaders' inbox", icon: SourcesGlyph, needsSession: false,
  component: lazyPane(() => import('./FleetInboxPane.js').then(m => m.FleetInboxPane)),
});
