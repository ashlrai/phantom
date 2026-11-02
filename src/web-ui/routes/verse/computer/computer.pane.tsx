import { lazyPane, registerPane } from '../panes/pane-registry.js';
import { PreviewGlyph } from '../dock/dock-icons.js';

registerPane({
  id: 'computer', title: 'Computer use', icon: PreviewGlyph, order: 25, toggle: true,
  component: lazyPane(() => import('./ComputerPane.js').then((m) => m.ComputerPane)),
});
