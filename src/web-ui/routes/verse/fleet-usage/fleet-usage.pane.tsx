import { lazyPane, registerPane } from '../panes/pane-registry.js';

/** A usage bar-meter glyph: three columns rising against a baseline. */
function UsageGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M2.25 13.75h11.5M4.75 13.25v-4M8 13.25V4M11.25 13.25V6.75" />
  </svg>;
}

registerPane({
  id: 'fleet-usage', title: 'Usage', icon: UsageGlyph, needsSession: false,
  description: 'Live usage per provider and tokens per lane.',
  component: lazyPane(() => import('./FleetUsagePane.js').then((m) => m.FleetUsagePane)),
});
