import { lazyPane, registerPane } from '../panes/pane-registry.js';

function GraphGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4h3m2 0h3M4 12h3m2 0h3M8 5v6" /><circle cx="3" cy="4" r="1" /><circle cx="13" cy="4" r="1" /><circle cx="3" cy="12" r="1" /><circle cx="13" cy="12" r="1" /></svg>;
}

registerPane({
  id: 'fleet-graph', title: 'Graph', description: 'Leaders, lanes and workers as a live graph', needsSession: false,
  icon: GraphGlyph,
  component: lazyPane(() => import('./FleetGraphPane.js').then((m) => m.FleetGraphPane)),
});
