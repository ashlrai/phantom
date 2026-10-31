import { lazyPane, registerPane } from '../panes/pane-registry.js';

function FleetGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 2h4v4H2zM10 2h4v4h-4zM2 10h4v4H2zM10 10h4v4h-4z" /></svg>;
}

registerPane({
  id: 'fleet-hub', title: 'Fleet', description: 'Every fleet pane, one click', needsSession: false,
  icon: FleetGlyph,
  component: lazyPane(() => import('./FleetHubPane.js').then((m) => m.FleetHubPane)),
});
