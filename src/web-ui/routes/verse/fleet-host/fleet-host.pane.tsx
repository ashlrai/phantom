import { lazyPane, registerPane } from '../panes/pane-registry.js';

function HostGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <rect x="2" y="2" width="12" height="9" rx="1" /><path d="M6 14h4M8 11v3" />
  </svg>;
}

registerPane({
  shortcut: 'mod+alt+h',
  id: 'fleet-host',
  title: 'Mac host',
  description: 'Memory, disk, tick and switches on the fleet Mac',
  needsSession: false,
  icon: HostGlyph,
  component: lazyPane(() => import('./FleetHostPane.js').then((m) => m.FleetHostPane)),
});
