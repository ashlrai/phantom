import { lazyPane, registerPane } from '../panes/pane-registry.js';

function BriefGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 2h10v12H3zM5 5h6M5 8h6M5 11h4" /></svg>;
}

registerPane({
  id: 'fleet-brief', title: 'Fleet brief', description: 'Copyable one-screen fleet status', needsSession: false,
  icon: BriefGlyph,
  component: lazyPane(() => import('./FleetBriefPane.js').then((m) => m.FleetBriefPane)),
});
