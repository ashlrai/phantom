import { lazyPane, registerPane } from '../panes/pane-registry.js';

/** A bar with a time marker: how much is used against how far the window has run. */
function PoolsGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M2.25 5h11.5M2.25 11h7M10.75 2.75v4.5M6.25 8.75v4.5" />
  </svg>;
}

registerPane({
  id: 'fleet-pools', title: 'Pools', icon: PoolsGlyph, needsSession: false,
  description: 'Every pool on one board: used, left, reset, burn, running jobs and per-model windows, most at risk of going unused first.',
  component: lazyPane(() => import('./FleetPoolsPane.js').then(m => m.FleetPoolsPane)),
});
