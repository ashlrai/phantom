import { lazyPane, registerPane } from '../panes/pane-registry.js';

function ConversationsGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 3h7v4.5h-4L3.5 9V7.5h-1z" /><path d="M11.5 6.5h2V11h-1v1.5L10.5 11h-4V9.5" />
  </svg>;
}

registerPane({
  id: 'session-wall',
  title: 'Conversations',
  description: 'Every agent session on one screen as a short conversation (summary and newest messages); open one to read all of it, write to it through the Leader, or follow its live log',
  needsSession: false,
  icon: ConversationsGlyph,
  component: lazyPane(() => import('./SessionWall.js').then(m => m.SessionWallPane)),
});
