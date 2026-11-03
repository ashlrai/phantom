import { lazyPane, registerPane } from '../panes/pane-registry.js';

function MissionGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5v4l2.5 1.5" /></svg>;
}

registerPane({
  shortcut: 'mod+alt+k',
  id: 'fleet-mission',
  title: 'Mission',
  description: 'Is the fleet healthy, what shipped, and what needs a look',
  needsSession: false,
  order: 5,
  icon: MissionGlyph,
  component: lazyPane(() => import('./FleetMissionPane.js').then((module) => module.FleetMissionPane)),
});
