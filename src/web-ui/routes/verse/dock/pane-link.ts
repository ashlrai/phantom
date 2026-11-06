import { normalizePaneId } from '../shell/dock-catalog.js';
import { deepLinkUrl } from '../shell/deep-link.js';

/** A shareable pane link, scoped to the chat only when the pane needs it. */
export function paneLinkUrl(paneId: string, sessionId: string | null, needsSession: boolean, base?: string): string | null {
  const pane = normalizePaneId(paneId);
  return pane ? deepLinkUrl({ paneId: pane, sessionId: needsSession ? sessionId : null }, base) : null;
}
