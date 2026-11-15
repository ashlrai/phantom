import { lazyPane, registerPane } from '../panes/pane-registry.js';

function ObserveGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" />
  </svg>;
}

registerPane({
  shortcut: 'mod+alt+v',
  id: 'fleet-observe',
  title: 'Observe',
  description: 'Every running session, merges, quota, agent comms and incidents',
  needsSession: false,
  order: 4,
  icon: ObserveGlyph,
  component: lazyPane(() => import('./ObservePane.js').then((m) => m.ObservePane)),
});
