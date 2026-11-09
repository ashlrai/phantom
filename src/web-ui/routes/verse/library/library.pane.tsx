import { FilesGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'library', title: 'Library', icon: FilesGlyph, needsSession: false,
  description: 'What Phantom remembers: project memory, past chats and the agent bus.',
  component: lazyPane(() => import('./LibraryPane.js').then(m => m.LibraryPane)),
});
