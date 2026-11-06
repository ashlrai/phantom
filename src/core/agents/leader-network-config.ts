import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Presence only, never authority. Dormant hosts avoid loading the network
 * worker's graph on every channel receipt or resident tick. The worker still
 * validates the host-owned file and exact identities before doing any work. */
export function hasLeaderNetworkConfig(): boolean {
  return existsSync(join(homedir(), '.ashlr', 'agent-network.toml'));
}
