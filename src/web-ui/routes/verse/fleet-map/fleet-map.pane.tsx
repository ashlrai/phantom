import { lazyPane, registerPane } from '../panes/pane-registry.js';

function MapGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="3" r="1.6" /><circle cx="3.5" cy="12.5" r="1.6" /><circle cx="12.5" cy="12.5" r="1.6" /><path d="M7.2 4.4 4.3 11M8.8 4.4l2.9 6.6M5.2 12.5h5.6" />
  </svg>;
}

registerPane({
  id: 'fleet-map',
  title: 'Map',
  description: 'The whole fleet on one map: leader, lanes, running jobs, computers, pools and who is messaging whom',
  needsSession: false,
  icon: MapGlyph,
  component: lazyPane(() => import('./MapPane.js').then(m => m.MapPane)),
});
