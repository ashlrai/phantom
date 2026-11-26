/**
 * app/sidecar-restart.ts — re-adopt the desktop shell's tokens when its
 * sidecar restarts (V3.10; see PhantomConsoleApp's header). Its own chunk since
 * 3.29.16: the event only ever fires long after first paint, so the listener
 * is installed a moment after the shell mounts instead of costing the chat's
 * first-paint critical JS.
 */
import { refreshDesktopSession } from '../data/auth-store.js';
import { invalidateVerseLists } from '../routes/verse/verse-queries.js';

/** DOM event the desktop shell fires after handing a restarted sidecar's tokens to this page. */
export const SIDECAR_RESTARTED_EVENT = 'ashlr:sidecar-restarted';

/**
 * Re-adopt host tokens whenever the desktop shell says its sidecar restarted.
 * Returns the disposer.
 *
 * Installed for the page's whole life, whatever the auth phase: the event may
 * land while the recovery screen is showing (adoption then replaces it,
 * because establishReadSession flips the phase) or while the app looks
 * authenticated on a dead cookie. After a successful adoption the lists are
 * refetched — the restarted server may have marked turns interrupted — and
 * the live streams reconnect on their own: their next attempt now carries a
 * valid cookie. A failed adoption changes nothing; the ordinary 401 path
 * still attempts to refresh the session. The event itself carries no data.
 */
export function listenForSidecarRestart(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  let inFlight = false;
  let again = false;
  let disposed = false;
  const onRestart = (): void => {
    if (disposed) return;
    // A second restart may leave newer tokens behind an in-flight exchange.
    // Run once more after that exchange instead of racing it for the cookie.
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void refreshDesktopSession()
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
