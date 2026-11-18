/**
 * routes/verse/channels/channels.pane.tsx — registers the Channels pane. The
 * pane registry is the ⌘K catalog's source for "Open pane: …", so this one
 * registration lists it in the palette and the dock's add menu.
 */
import { lazyPane, registerPane } from '../panes/pane-registry.js';

/** Two speech bubbles: talking to the Leader over more than one line. */
function ChannelsGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.25 3.25h7.5v5h-4.5l-3 2.5v-2.5h0z" />
    <path d="M11.75 6.25h2v5h-1.5v2l-2.5-2h-3.5v-1" />
  </svg>;
}

registerPane({
  id: 'channels', title: 'Channels', icon: ChannelsGlyph, needsSession: false,
  description: 'Is each way to reach the Leader working? iMessage, Slack, Telegram, email, mobile, desktop: last message in and out, and the next step.',
  component: lazyPane(() => import('./ChannelsPane.js').then(m => m.ChannelsPane)),
});
