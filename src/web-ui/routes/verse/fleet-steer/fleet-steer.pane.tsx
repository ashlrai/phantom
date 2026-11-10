import { lazyPane, registerPane } from '../panes/pane-registry.js';

function SteerGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" />
      <path d="M8 5.5a2.5 2.5 0 1 0 2.5 2.5" />
      <path d="M13.5 2.5 9.5 6.5" />
    </svg>
  );
}

registerPane({
  id: 'fleet-steer',
  title: 'Steer',
  icon: SteerGlyph,
  needsSession: false,
  description: 'Steer the fleet: a note to the leaders, queue reprioritize, or a job stop.',
  component: lazyPane(() => import('./SteerPane.js').then((m) => m.SteerPane)),
});
