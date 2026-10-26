/**
 * app/sidecar-restart.ts — re-adopt the desktop shell's tokens when its
 * sidecar restarts (V3.10; see VerseConsoleApp's header). Its own chunk since
 * 3.29.16: the event only ever fires long after first paint, so the listener
 * is installed a moment after the shell mounts instead of costing the chat's
 * first-paint critical JS.
 */
import { adoptInjectedTokens } from '../data/auth-store.js';
import { invalidateVerseLists } from '../routes/verse/verse-queries.js';

/** DOM event the desktop shell fires after handing a restarted sidecar's tokens to this page. */
export const SIDECAR_RESTARTED_EVENT = 'ashlr:sidecar-restarted';

/**
 * Re-adopt host tokens whenever the desktop shell says its sidecar restarted.
 * Returns the disposer.
 *
 * Installed for the page's whole life, whatever the auth phase: the event may
 * land while the SessionGate is showing (adoption then replaces the prompt,
 * because establishReadSession flips the phase) or while the app looks
 * authenticated on a dead cookie. After a successful adoption the lists are
 * refetched — the restarted server may have marked turns interrupted — and
 * the live streams reconnect on their own: their next attempt now carries a
 * valid cookie. A failed adoption changes nothing; the ordinary 401 path
 * still ends at the SessionGate. The event carries no data, so a page script
 * firing it can at most make the page re-read tokens that are already there.
 */
export function listenForSidecarRestart(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  let inFlight = false;
  let again = false;
  let disposed = false;
  const onRestart = (): void => {
    if (disposed) return;
    // Restarts in quick succession: adoption reads `window.__ASHLR_TOKENS__`
    // when it STARTS, so a second restart during an exchange left newer
    // tokens behind it. Run exactly once more after the current exchange
    // instead of racing a second one for the cookie.
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void adoptInjectedTokens()
      .then((adopted) => { if (adopted) invalidateVerseLists(); })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          onRestart();
        }
      });
  };
  target.addEventListener(SIDECAR_RESTARTED_EVENT, onRestart);
  return () => {
    disposed = true;
    target.removeEventListener(SIDECAR_RESTARTED_EVENT, onRestart);
  };
}
