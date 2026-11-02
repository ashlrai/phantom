import { lazyPane, registerPane } from '../panes/pane-registry.js';

function LanesGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M2 3h12M2 8h12M2 13h12M5 2v2M10 7v2M7 12v2" />
  </svg>;
}

registerPane({
  shortcut: 'mod+alt+n',
  id: 'fleet-lanes',
  title: 'Lanes',
  description: 'Live lanes, workers and merges from the Mac fleet',
  needsSession: false,
  icon: LanesGlyph,
  component: lazyPane(() => import('./FleetLanesPane.js').then((m) => m.FleetLanesPane)),
});
