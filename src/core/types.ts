/**
 * Shared contracts, grouped by domain in ./types/.
 * Existing consumers can continue importing from this public entry point.
 * Cross-domain references use type-only imports from their owning module.
 * Subsystems with their own contracts remain the source of truth for those types.
 *
 * Safety contract notes (see config.ts and proposals.ts for the declarations):
 * - protected PR handoff; never merges the hosted PR: pushToRemote.
 * - M183: frontier TASTE critic for best-of-N SELECTION.
 *   Does NOT add any merge gate; the safety floor is unchanged.
 * - M183: Frontier TASTE critic scores are optional selection/curation metadata.
 *   Does NOT affect the safety merge gate.
 *
 * Endpoint documentation for config.ts (these types perform no transport):
 * NIM exposes POST /v1/chat/completions at https://integrate.api.nvidia.com
 * (verified 2026-06). visualGrounding.endpoint accepts a base URL or a full
 * /chat/completions URL; remote endpoints require allowRemoteEndpoint=true.
 */

// Keep the sole runtime export here so the runtime module graph is unchanged.
export const DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT = 3;

export type * from './types/backlog.js';
export type * from './types/config.js';
export type * from './types/daemon.js';
export type * from './types/dashboard.js';
export type * from './types/delegation.js';
export type * from './types/doctor.js';
export type * from './types/engines.js';
export type * from './types/genome.js';
export type * from './types/goals.js';
export type * from './types/health.js';
export type * from './types/integrations.js';
export type * from './types/knowledge.js';
export type * from './types/learning.js';
export type * from './types/observability.js';
export type * from './types/oversight.js';
export type * from './types/portfolio.js';
export type * from './types/projects.js';
export type * from './types/proposals.js';
export type * from './types/providers.js';
export type * from './types/routing.js';
export type * from './types/run.js';
export type * from './types/sandbox.js';
export type * from './types/skills.js';
export type * from './types/swarm.js';
export type * from './types/tools.js';
export type * from './types/web.js';
export type * from './types/workspace.js';
