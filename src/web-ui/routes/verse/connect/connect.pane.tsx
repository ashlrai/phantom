/**
 * routes/verse/connect/connect.pane.tsx: registers the Connect pane. The pane
 * registry feeds the ⌘K catalog and the dock's add menu, so this is the only
 * registration it needs.
 */
import { lazyPane, registerPane } from '../panes/pane-registry.js';

/** A plug: two prongs, a body and a lead. */
function ConnectGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.75 1.75v3M10.25 1.75v3M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0zM8 11.5v2.75" />
  </svg>;
}

registerPane({
  id: 'connect', title: 'Connect', icon: ConnectGlyph, needsSession: false,
  description: 'Everything the fleet can plug into: channels, connectors, plugins, skills and tools. Is each one on, who uses it, and the next step.',
  component: lazyPane(() => import('./ConnectPane.js').then(m => m.ConnectPane)),
});
