import { lazyPane, registerPane } from '../panes/pane-registry.js';
function TeamGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="6" cy="5" r="2.5" /><path d="M1 14v-2a5 5 0 0 1 10 0v2M11 3a2.5 2.5 0 0 1 0 5M13 10a4 4 0 0 1 2 4" /></svg>;
}
registerPane({ id: 'fleet-team', title: 'Team', description: 'Teammates, verified identities, shared lanes and agent seats', needsSession: false,
  icon: TeamGlyph, component: lazyPane(() => import('./TeamPane.js').then(m => m.TeamPane)) });
