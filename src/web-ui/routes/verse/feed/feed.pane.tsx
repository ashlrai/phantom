import { SourcesGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'feed', title: 'Feed', icon: SourcesGlyph, needsSession: false,
  description: 'One stream of Leader news, alerts, merges and fleet updates, newest first.',
  component: lazyPane(() => import('./FeedSection.js').then(m => m.FeedSection)),
});
