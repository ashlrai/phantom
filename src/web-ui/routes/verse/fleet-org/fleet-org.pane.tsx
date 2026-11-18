import { lazyPane, registerPane } from '../panes/pane-registry.js';

function OrgGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="6" y="1.5" width="4" height="3.5" rx="1" /><rect x="1.5" y="11" width="4" height="3.5" rx="1" /><rect x="10.5" y="11" width="4" height="3.5" rx="1" /><path d="M8 5v3M3.5 11V8h9v3" />
  </svg>;
}

registerPane({
  id: 'fleet-org',
  title: 'Org',
  description: 'Org structure: the leader, each lane and the jobs under it, with provider, model and state',
  needsSession: false,
  icon: OrgGlyph,
  component: lazyPane(() => import('./OrgPane.js').then(m => m.OrgPane)),
});
