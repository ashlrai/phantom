/**
 * routes/verse/shell/HomeSurface.tsx — mounts the landing pane (Leader or Feed)
 * straight into the shell, outside the dock. Both panes read only `visible`,
 * so the session-shaped props are empty; the pane's own content is untouched.
 */
import type { PaneHost, PaneProps } from '../panes/pane-registry.js';
import { getPane } from '../panes/pane-registry.js';
import styles from './HomeSurface.module.css';

const NOOP = () => {};
const HOST: PaneHost = {
  sendToChat: NOOP, addToMessage: NOOP, openPane: NOOP, closePane: NOOP,
  openTerminal: NOOP, openTerminalBelow: NOOP, openDiff: NOOP, openSession: NOOP,
};
const REQUESTS: PaneProps['requests'] = { terminal: null, preview: null, diff: null };

export function HomeSurface({ paneId, visible, compact }: { paneId: 'leader-thread' | 'feed'; visible: boolean; compact: boolean }) {
  const pane = getPane(paneId);
  if (!pane) return null;
  const Pane = pane.component;
  return (
    <div className={styles.home} data-home-pane={paneId} data-compact={compact || undefined}>
      <Pane paneId={paneId} sessionId={null} session={null} roots={[]} events={[]} turnFiles={[]}
        visible={visible} presentation="column" requests={REQUESTS} host={HOST} />
    </div>
  );
}
