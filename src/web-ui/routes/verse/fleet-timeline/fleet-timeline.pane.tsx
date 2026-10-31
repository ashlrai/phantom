import { lazyPane, registerPane } from '../panes/pane-registry.js';

function TimelineGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M2 3h7M4 8h10M2 13h5" />
  </svg>;
}

registerPane({
  shortcut: 'mod+alt+t',
  id: 'fleet-timeline',
  title: 'Worker timeline',
  description: 'Running workers by fleet lane',
  needsSession: false,
  icon: TimelineGlyph,
  component: lazyPane(() => import('./FleetTimelinePane.js').then((m) => m.FleetTimelinePane)),
});
