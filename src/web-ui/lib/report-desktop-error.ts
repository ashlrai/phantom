/**
 * lib/report-desktop-error.ts — best-effort render-crash reporting from the
 * error boundaries to the local verse server (RQ-PHX-DESKTOPCRASHREPORT100).
 *
 * Before this, componentDidCatch only wrote to console.error: the crash was
 * visible in devtools and nowhere else. Now the boundary also POSTs the crash
 * to /api/verse/desktop-errors, where the server truncates, scrubs and
 * fingerprints it into ~/.ashlr-runs/desktop/errors.jsonl for
 * `ashlr fleet desktop-errors`.
 *
 * Hard rules, by design:
 *   - FIRE AND FORGET. Reporting must never throw, never reject outward and
 *     never block a boundary's render path — a crash report cannot crash.
 *   - At most 5 reports per minute per page (sliding window): a boundary
 *     that keeps re-tripping on every render cannot flood the ledger. The
 *     server still dedupes identical crashes for 10 minutes on top of this.
 *   - Mutation authority only. A report writes a file, so it rides the same
 *     x-ashlr-token gate as every other POST; with no token held there is
 *     nothing to send and the call is a no-op.
 */
import { getMutationToken } from '../data/auth-store.js';
import { apiPost } from '../data/client.js';
import { APP_VERSION } from '../routes/verse/sections/app-version.js';

export const DESKTOP_ERRORS_PATH = '/api/verse/desktop-errors';
const MAX_REPORTS_PER_MINUTE = 5;
const WINDOW_MS = 60_000;
const sentAt: number[] = [];

/** `/verse/fleet` -> `route:verse.fleet`; `/` -> `route:root` — the surface charset has no `/`. */
export function desktopSurfaceForRoute(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  return `route:${segments.length === 0 ? 'root' : segments.join('.')}`;
}

/**
 * Report one caught render crash. `surface` is the route (via
 * desktopSurfaceForRoute) or the pane/helper id the boundary wraps.
 */
export function reportDesktopError(surface: string, error: unknown, componentStack?: string | null): void {
  try {
    const now = Date.now();
    while (sentAt.length > 0 && now - sentAt[0]! >= WINDOW_MS) sentAt.shift();
    if (sentAt.length >= MAX_REPORTS_PER_MINUTE) return;
    const token = getMutationToken();
    if (token === null) return;
    sentAt.push(now);
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'unknown render error');
    void apiPost(DESKTOP_ERRORS_PATH, {
      surface,
      message: err.message || String(error),
      ...(typeof err.stack === 'string' && err.stack ? { stack: err.stack } : {}),
      ...(typeof componentStack === 'string' && componentStack ? { componentStack } : {}),
      appVersion: APP_VERSION,
    }, token).then(() => undefined, () => undefined);
  } catch {
    // The boundary's fallback is already rendering; a reporting failure is silent.
  }
}
