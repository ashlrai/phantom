import { lazyPane, registerPane } from '../panes/pane-registry.js';

function OutcomesGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="m5.5 8 1.75 1.75L10.75 6" /></svg>;
}

registerPane({
  id: 'fleet-outcomes', title: 'Outcomes',
  description: 'What happened to each job the fleet executed: produced, verified, merged, reverted',
  needsSession: false, icon: OutcomesGlyph,
  component: lazyPane(() => import('./FleetOutcomesPane.js').then(m => m.FleetOutcomesPane)),
});
