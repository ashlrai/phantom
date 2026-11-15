// The update-phase readers live in read.ts: anything this module re-exports
// is already inside the Tier-1 authority import closure through read.ts, so
// keeping the logic there avoids growing the closure snapshot for a pure
// plumbing seam. Importers (tests, web) may keep importing this path.
export { readUpdatePhase, updatePhaseFromStatus } from './read.js';
