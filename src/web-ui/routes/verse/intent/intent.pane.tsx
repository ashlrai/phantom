import { lazyPane, registerPane } from '../panes/pane-registry.js';

function IntentGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M3 3.5h10M3 8h10M3 12.5h6" /><circle cx="12.5" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>;
}

registerPane({
  shortcut: 'mod+alt+y',
  id: 'intent',
  title: 'Intent',
  description: 'Owner directives, the pulls that carry them, and which have gone stale',
  needsSession: false,
  order: 46,
  icon: IntentGlyph,
  component: lazyPane(() => import('./IntentPane.js').then((module) => module.IntentPane)),
});
