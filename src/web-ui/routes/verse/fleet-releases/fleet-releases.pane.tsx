import { lazyPane, registerPane } from '../panes/pane-registry.js';

function ReleasesGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 3h6l6 6-5 5-7-7V3ZM5 5h.01" />
  </svg>;
}

registerPane({
  id: 'fleet-releases', title: 'Releases',
  description: 'Release train per enrolled repo: version, tag, latest release and workflow run',
  needsSession: false, icon: ReleasesGlyph,
  component: lazyPane(() => import('./FleetReleasesPane.js').then(m => m.FleetReleasesPane)),
});
