// The classifier lives in empty-jobs.ts: that module is already inside the
// Tier-1 authority import closure, so hosting the rules there keeps the
// closure snapshot unchanged. This module is the stable public surface.
export { classifyEmptyLog, FLEET_EMPTY_WHY_LOG_LINES, FLEET_EMPTY_WHY_REASONS, type FleetEmptyWhyReason } from './empty-jobs.js';
