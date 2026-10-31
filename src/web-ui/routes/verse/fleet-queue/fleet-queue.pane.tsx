import { lazyPane, registerPane } from '../panes/pane-registry.js';

function QueueGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M2 3h12M2 8h12M2 13h8" />
  </svg>;
}

registerPane({
  id: 'fleet-queue',
  title: 'Queue',
  description: 'Parked and ready jobs by lane, with precheck skips',
  needsSession: false,
  icon: QueueGlyph,
  component: lazyPane(() => import('./FleetQueuePane.js').then((m) => m.FleetQueuePane)),
});
