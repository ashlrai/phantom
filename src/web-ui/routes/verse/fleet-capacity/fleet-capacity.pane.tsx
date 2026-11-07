import { lazyPane, registerPane } from '../panes/pane-registry.js';

function CapacityGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2 13V3M2 13h12M4 10l3-3 2 2 4-5" /></svg>;
}

registerPane({
  id: 'fleet-capacity', title: 'Capacity',
  description: 'Per-lane running vs target over the last day, and where launches stalled',
  needsSession: false, icon: CapacityGlyph,
  component: lazyPane(() => import('./FleetCapacityPane.js').then((m) => m.FleetCapacityPane)),
});
