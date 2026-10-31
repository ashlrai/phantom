import { lazyPane, registerPane } from '../panes/pane-registry.js';

function JournalGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 2h8v12H4zM2 4h2M2 8h2M2 12h2M6.5 5h3M6.5 8h3M6.5 11h2" />
  </svg>;
}

registerPane({
  id: 'leader-journal',
  title: 'Leader journal',
  description: 'What the leaders saw and did each pass, and which job files the drop accepted or rejected',
  needsSession: false,
  icon: JournalGlyph,
  component: lazyPane(() => import('./LeaderJournalPane.js').then((m) => m.LeaderJournalPane)),
});
