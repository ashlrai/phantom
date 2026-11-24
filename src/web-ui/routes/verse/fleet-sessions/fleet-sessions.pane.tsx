import { lazyPane, registerPane } from '../panes/pane-registry.js';

function SessionsGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 4h11M2.5 8h11M2.5 12h7" /><circle cx="12.5" cy="12" r="1.3" />
  </svg>;
}

registerPane({
  id: 'fleet-sessions',
  title: 'Sessions',
  description: 'Every agent session as one tree (leader, workers, subagents) with its last message and quiet ones highlighted; open one to see its messages, pause or stop it',
  needsSession: false,
  icon: SessionsGlyph,
  component: lazyPane(() => import('./SessionsPane.js').then(m => m.SessionsPane)),
});
