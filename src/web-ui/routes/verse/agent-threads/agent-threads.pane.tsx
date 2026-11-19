import { lazyPane, registerPane } from '../panes/pane-registry.js';

function ThreadsGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 3.5h7v5h-4l-3 2.2z" /><path d="M11.5 6.5h2v5h-1.5v2l-2.6-2H7.5" />
  </svg>;
}

registerPane({
  shortcut: 'mod+alt+a',
  id: 'agent-threads',
  title: 'Agent threads',
  description: 'Every agent session as a conversation: what each is doing, a summary from its records, and its messages',
  needsSession: false,
  icon: ThreadsGlyph,
  component: lazyPane(() => import('./AgentThreadsPane.js').then(m => m.AgentThreadsPane)),
});
