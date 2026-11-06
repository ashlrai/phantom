import { lazyPane, registerPane } from '../panes/pane-registry.js';

function SteeringGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3h11M2.5 7.5h6.5M2.5 12h4" />
      <path d="m11 9.5 2.5 2.5L11 14.5" />
    </svg>
  );
}

registerPane({
  id: 'fleet-steering',
  title: 'Steering',
  icon: SteeringGlyph,
  needsSession: false,
  description: 'Your orders to the leaders and what happened after each.',
  component: lazyPane(() => import('./FleetSteeringPane.js').then((m) => m.FleetSteeringPane)),
});
