/**
 * routes/verse/shell/surface-prefetch.ts — the reads each rail surface opens
 * with, so the shell can warm them while the operator is still reading chat
 * (shell/warmup.ts, once the operator is idle after first paint). A first
 * visit to Command, Fleet, Growth or Mind then paints from the cache instead
 * of a skeleton; the surface's own useQuery still refreshes whatever is older
 * than it accepts.
 *
 * LAZY ONLY. shell/warmup.ts loads this module with import(): these query
 * defs pull in the surfaces' data modules, none of which may cost chat
 * first-paint bytes (VerseApp.first-paint.test.ts pins it). The QueryDefs
 * themselves are the surfaces' own — same keys, same fetchers — so a warmed
 * entry IS the entry the surface reads.
 *
 * Keep each list in step with its surface's useQuery calls:
 * surface-prefetch.test.ts renders Command, Growth and Mind and fails when
 * they read something this table does not warm.
 */
import { ensureQuery } from '../../../data/cache.js';
import { modelsQuery, type QueryDef } from '../../../data/queries.js';
import { overnightQuery } from '../autonomy/overnight-queries.js';
import { budgetPreviewQuery, budgetQuery } from '../budget/budget-queries.js';
import { cloudQuery } from '../cloud/cloud-queries.js';
import {
  authorityQuery,
  fleetHistoryQuery,
  fleetLiveQuery,
  leaderQuery,
  learningQuery,
  reasoningDigestQuery,
} from '../command/surface-data.js';
import { leaderDirectivesQuery, leaderThreadQuery } from '../leader/thread-data.js';
import { fleetControlQuery, fleetQueueQuery } from '../fleet/fleet-control-queries.js';
import { outcomesQuery } from '../fleet/outcomes-queries.js';
import { adoptionQuery } from '../growth/adoption-data.js';
import { lessonsQuery } from '../growth/lessons-data.js';
import { verseBootstrapQuery, verseSessionsQuery, verseWorkspacesQuery } from '../verse-queries.js';
import type { VerseSectionId } from '../verse-ui-store.js';

type AnyQuery = QueryDef<unknown>;

/** What each rail surface reads the moment it mounts. */
export const SURFACE_PREFETCH: Readonly<Partial<Record<VerseSectionId, readonly AnyQuery[]>>> = {
  // No seat history: the burn-downs that drew it moved to Usage (audit 14);
  // Command's seat strip reads the budget and the rail's warm seat caches.
  // cloudQuery (3.11): the Cloud card's overview — without it a first visit
  // paints "Reading the cloud lane…" under the seat strip.
  // leaderThreadQuery: the Leader card's latest-message line (leader/LeaderLine).
  // fleetControlQuery (3.15): Command's one line about the fleet (fleet/FleetStatusLink).
  command: [authorityQuery, fleetLiveQuery, leaderQuery, learningQuery, fleetHistoryQuery, budgetQuery, cloudQuery, leaderThreadQuery, fleetControlQuery],
  // authorityQuery + fleetLiveQuery on Fleet, Growth and Mind: the shared
  // "Autonomy is off" state (autonomy/AutonomyOffState) reads both.
  // fleetControlQuery + fleetQueueQuery (3.15): the control surface and the steer panel.
  // outcomesQuery: the lead's outcomes panel (fleet/OutcomesPanel, lazy).
  fleet: [fleetLiveQuery, authorityQuery, overnightQuery, budgetQuery, budgetPreviewQuery, fleetControlQuery, fleetQueueQuery, outcomesQuery],
  // adoptionQuery + lessonsQuery: Growth's two lazy panels, which otherwise
  // ask only once their chunks have loaded and the section has rendered.
  growth: [fleetHistoryQuery, learningQuery, modelsQuery('30d'), authorityQuery, fleetLiveQuery, adoptionQuery, lessonsQuery],
  // The conversation (leader/LeaderConversation) reads the thread and the directives.
  mind: [leaderQuery, leaderThreadQuery, leaderDirectivesQuery, reasoningDigestQuery, verseBootstrapQuery, verseWorkspacesQuery, authorityQuery, fleetLiveQuery],
  chat: [verseBootstrapQuery, verseSessionsQuery, verseWorkspacesQuery],
};

/**
 * The surfaces whose first visit mounts lazy panels (each section's
 * `preloadPanels`). Loaded with the surface's own chunk, so the first visit
 * renders them in the same pass instead of a fallback (command/Surface.tsx
 * lazyPanel). The section chunk is already in by then (warmup.ts loads it
 * first), so these imports only reach its exports.
 */
export const SURFACE_PANELS: Readonly<Partial<Record<VerseSectionId, () => Promise<{ preloadPanels: () => Promise<unknown> }>>>> = {
  fleet: () => import('../sections/FleetSection.js'),
  growth: () => import('../sections/GrowthSection.js'),
  mind: () => import('../sections/MindSection.js'),
};

/** Load one surface's lazy panels. Never rejects: each panel's own load asks again on mount. */
export async function prefetchSurfacePanels(id: VerseSectionId): Promise<void> {
  try {
    const section = await SURFACE_PANELS[id]?.();
    await section?.preloadPanels();
  } catch {
    // Left to the panel's own load.
  }
}

/**
 * A cached answer younger than this is left alone. The surfaces accept 10–60 s
 * old data on mount, so anything fresher than a minute is already as good as
 * a warm-up can make it.
 */
export const PREFETCH_FRESH_MS = 60_000;

type Ensure = (key: string, fetcher: () => Promise<unknown>, maxAgeMs: number) => Promise<void>;

export interface PrefetchOptions {
  /** The cache's mount path (a seam for tests). */
  ensure?: Ensure;
  /**
   * Awaited before EACH read (the warm-up's idle gate). Resolving false stops
   * the warm-up there — the gate was cancelled.
   */
  beforeEach?: () => Promise<boolean> | boolean;
}

/**
 * Warm one surface's reads through the shared cache (joins an in-flight read,
 * skips a fresh one, and goes through the cache's concurrency gate).
 *
 * ONE AT A TIME: each read is awaited before the next is even considered, so
 * the warm-up never holds more than one of the gate's slots, and the operator
 * (who gets the other three, and whose reads the next `beforeEach` waits out)
 * is never queued behind a burst of it.
 *
 * Never rejects: a read that fails leaves the surface to load it as it always did.
 */
export async function prefetchSurfaceData(id: VerseSectionId, options: PrefetchOptions = {}): Promise<void> {
  const ensure = options.ensure ?? ensureQuery;
  for (const def of SURFACE_PREFETCH[id] ?? []) {
    try {
      if (options.beforeEach && !(await options.beforeEach())) return;
      await ensure(def.key, () => def.fetch(), PREFETCH_FRESH_MS);
    } catch {
      // A warm-up read that fails (or cannot even start) is not worth surfacing.
    }
  }
}
