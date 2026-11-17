import { lazyPane, registerPane } from '../panes/pane-registry.js';

function ComputersGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <rect x="1.5" y="3" width="8" height="6" rx="1" /><rect x="6.5" y="7" width="8" height="6" rx="1" />
  </svg>;
}

registerPane({
  id: 'fleet-computers',
  title: 'Computers',
  description: 'Every computer in your pool: reachable, running Phantom, ready for work',
  needsSession: false,
  icon: ComputersGlyph,
  component: lazyPane(() => import('./ComputersPane.js').then((m) => m.ComputersPane)),
});
