import { lazyPane, registerPane } from '../panes/pane-registry.js';

function DirectGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="4" rx="1" /><path d="M1.5 9.5h5M1.5 12.5h8M11 10l3 2.5-3 2.5" />
  </svg>;
}

registerPane({
  id: 'fleet-direct',
  title: 'Direct',
  description: 'One line to the leader, with live fleet, merges, releases, nodes, agents and spend',
  needsSession: false,
  icon: DirectGlyph,
  component: lazyPane(() => import('./DirectPane.js').then(m => m.DirectPane)),
});
