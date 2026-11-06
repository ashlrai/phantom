/**
 * app/update-reload-query.ts — the update-reload banner's read of
 * GET /api/verse/ops/self-update. Its own cache key rather than the gear
 * tray's 'verse-self-update-badge': that entry latches on 404 for the life
 * of the page (shell/self-update-badge.ts), and this poll must keep asking —
 * the route may only appear once the sidecar restarts onto code that has it.
 */
import { VERSE_OPS_SELF_UPDATE_PATH, type OpsSelfUpdateV1 } from '../../core/verse/ops-types.js';
import { apiGet } from '../data/client.js';
import type { QueryDef } from '../data/queries.js';

export const updateReloadQuery: QueryDef<OpsSelfUpdateV1> = {
  key: 'verse-ops-self-update',
  fetch: (signal) => apiGet<OpsSelfUpdateV1>(VERSE_OPS_SELF_UPDATE_PATH, signal),
};
