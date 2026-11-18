import { FilesGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'library', title: 'Library', icon: FilesGlyph, needsSession: false,
  description: 'Files, memory, context and agent messages in one place.',
  component: lazyPane(() => import('./LibraryPane.js').then(m => m.LibraryPane)),
});
