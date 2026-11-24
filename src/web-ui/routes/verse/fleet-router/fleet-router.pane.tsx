import { lazyPane, registerPane } from '../panes/pane-registry.js';

/** One source splitting to three seats, the first drawn solid: the order a call would be tried in. */
function RouterGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.25 8h4M6.25 8l3.5-4.25h2M6.25 8h5.5M6.25 8l3.5 4.25h2" />
    <circle cx="12.75" cy="3.75" r="1" fill="currentColor" />
  </svg>;
}

registerPane({
  id: 'fleet-router', title: 'Router', icon: RouterGlyph, needsSession: false,
  description: 'Where each kind of work would go: a route table by task and difficulty, seats in the order the router would try them, with usage and resets, and where recent decisions went.',
  component: lazyPane(() => import('./FleetRouterPane.js').then(m => m.FleetRouterPane)),
});
