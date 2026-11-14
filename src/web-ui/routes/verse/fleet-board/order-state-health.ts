/**
 * routes/verse/fleet-board/order-state-health.ts — pure (no React) reading of the
 * `live` and `sources` health fields of the order-state body, so the strip can
 * show "could not check" instead of presenting ASSIGNED/RECEIVED as final.
 * Never throws: hostile input degrades to "nothing known".
 */
export interface OrderStripHealth {
  /** true = live workers checked, false = unavailable (RUNNING never checked), null = older server. */
  liveChecked: boolean | null;
  degradedSources: string[];
  notice: string | null;
}

const MAX_NAME = 40;
const MAX_LISTED = 6;

export function orderStripHealth(body: unknown): OrderStripHealth {
  try {
    const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const liveChecked = b.live === 'healthy' ? true : b.live === 'unavailable' ? false : null;

    let degraded: string[] = [];
    const s = b.sources;
    if (s === 'unavailable') degraded = ['all'];
    else if (s !== null && typeof s === 'object' && !Array.isArray(s)) {
      degraded = Object.keys(s).filter((k) => (s as Record<string, unknown>)[k] !== 'healthy').sort();
    }
    const degradedSources = degraded.map((n) => n.slice(0, MAX_NAME));

    const parts: string[] = [];
    if (liveChecked === false) parts.push('Live workers unreadable · RUNNING not checked');
    if (degradedSources.length > 0) {
      const shown = degradedSources.slice(0, MAX_LISTED).join(', ');
      const more = degradedSources.length - MAX_LISTED;
      parts.push(`Order sources degraded: ${shown}${more > 0 ? ` +${more} more` : ''}`);
    }
    return { liveChecked, degradedSources, notice: parts.length > 0 ? parts.join(' · ') : null };
  } catch {
    return { liveChecked: null, degradedSources: [], notice: null };
  }
}
