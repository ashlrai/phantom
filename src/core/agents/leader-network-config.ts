import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { realHome } from '../real-home.js';

/** Presence only, never authority. Dormant hosts avoid loading the network
 * worker's graph on every channel receipt or resident tick. The worker still
 * validates the host-owned file and exact identities before doing any work.
 * The path is the account home, so a relocated `$HOME` cannot hide or forge it. */
export function hasLeaderNetworkConfig(): boolean {
  const home = realHome();
  if (!home) return false;
  return existsSync(join(home, '.ashlr', 'agent-network.toml'));
}
