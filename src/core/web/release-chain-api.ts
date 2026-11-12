import { homedir } from 'node:os';
import { join } from 'node:path';
import { readReleaseChainStatus } from '../fleet/release-chain-status.js';

/** Read the same local signing evidence as the fleet CLI. */
export function releaseChainResponse(runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')) {
  return readReleaseChainStatus({ runsDir });
}
