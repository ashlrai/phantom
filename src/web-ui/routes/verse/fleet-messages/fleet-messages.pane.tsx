import { lazyPane, registerPane } from '../panes/pane-registry.js';

function MessagesGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 3.5h8v5H5.5L3 10.5v-2H2z" /><path d="M10 6h4v5h-1v2l-2.5-2H7V8.5" />
  </svg>;
}

registerPane({
  id: 'fleet-messages',
  title: 'Messages',
  description: 'What agents say to each other: asks, replies, handoffs, status and blockers, grouped by conversation',
  needsSession: false,
  icon: MessagesGlyph,
  component: lazyPane(() => import('./MessagesPane.js').then(m => m.MessagesPane)),
});
