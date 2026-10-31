import { SourcesGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'sources',
  title: 'Sources',
  icon: SourcesGlyph,
  description: 'Every file, page, search and doc this chat drew on — numbered, with the turns that cited each.',
  component: lazyPane(() => import('./dock-panes.js').then((m) => m.SourcesDockPane)),
});

