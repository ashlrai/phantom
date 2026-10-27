import { requireBuiltDist } from './require-built-dist.js';

requireBuiltDist();

// Static import would load scripts/build-release-dependency-inventory.mjs,
// which imports dist/, before requireBuiltDist can explain a missing build.
const loaded = await import('../../scripts/build-release-dependency-inventory.mjs');

export const resolveNpmCliLaunch = loaded.resolveNpmCliLaunch;
export const runTrustedNpmCli = loaded.runTrustedNpmCli;
